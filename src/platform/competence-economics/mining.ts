/**
 * Successful-trajectory mining (platform competence-economics plane;
 * WORK-056 / E1.1 — ADR-0019, ADR-0020).
 *
 * MINING OBSERVES, NEVER DECIDES (the Work Order's fourth
 * architecture invariant): successful trajectories become CANDIDATE
 * competence records through the merged failure-recovery /
 * decision-record evidence — mining is OBSERVATION over what the
 * existing seams already recorded, never a promotion, never an
 * authority, never a re-implementation of their attribution.
 *
 * The input discipline (fail-closed, total):
 *
 *  - a SUCCESSFUL TRAJECTORY is what the existing execution/decision
 *    seams report: the governed execution's identity, the WORK-049
 *    decision record that governed it (the decision-record store
 *    evidence), the verification authority's own measurement (the
 *    observed quality + the verification binding — recorded, never
 *    re-judged: VERIFICATION-SEPARATION), the observed cost and
 *    latency, the executor identity, the environment fingerprint
 *    (WORK-055's own typed identity), and the digest of the raw
 *    trajectory event bytes (the durable provenance). Only
 *    `success` outcomes are minable — everything else is a typed
 *    rejection, never a guess;
 *  - when the successful execution recovered from a failure on its
 *    way to success, the failure-recovery plane's OWN validated
 *    attribution rides the trajectory (imported read-only through
 *    `validateFailureAttribution` — the exact provenance chain,
 *    never re-implemented);
 *  - the MINING CORPUS carries the trajectories of ONE applicability
 *    shape (capability + tags + ONE environment), the total
 *    execution count observed for that shape (the honest
 *    reliability denominator), and the MINING AUTHORITY identity —
 *    which must differ from every trajectory executor (an agent
 *    never mines its own output into competence);
 *  - the repetition discipline: at least MIN_SUCCESSFUL_TRAJECTORIES
 *    distinct successful trajectories are required (single lucky
 *    runs never become competence — `insufficient-repetition`).
 *
 * The output discipline (evidence-honest, conservative):
 *
 *  - the mined record's expected quality is the MINIMUM observed
 *    quality (evidence never exceeds the weakest observation);
 *  - the expected reliability is the observed success ratio
 *    (successes / total executions — an input, never invented);
 *  - the expected cost and latency are the MAXIMUM observed (the
 *    conservative bound of the evidence);
 *  - the claim's basis is `observed` with the mining source and the
 *    trajectory-digest evidence pin (the foundation's OWN
 *    explicit-basis discipline);
 *  - the mined record's stage is ALWAYS `candidate` — mining NEVER
 *    promotes (the promotion gates are separate governed steps).
 *
 * Pure and deterministic: no clock, no randomness, no ambient state
 * (architecture invariant 5).
 */

import type { TenantCacheScope } from "../context-economics/keys";
import { validateTenantCacheScope } from "../context-economics/keys";
import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import type { FailureAttribution } from "../failure-recovery/attribution";
import { validateFailureAttribution } from "../failure-recovery/attribution";
import {
  type EnvironmentFingerprint,
  validateEnvironmentFingerprint,
} from "../failure-recovery/fingerprint";
import {
  AUTHORITY_ID_PATTERN,
  boundedDetail,
  CAPABILITY_REF_PATTERN,
  MAX_MINING_TRAJECTORIES,
  MIN_SUCCESSFUL_TRAJECTORIES,
  reject,
  SHA256_HEX_PATTERN,
  TAG_PATTERN,
} from "./catalog";
import { buildCompetenceRecord, type CompetenceRecord } from "./record";

// ---------------------------------------------------------------------------
// The successful trajectory (what the existing seams report)
// ---------------------------------------------------------------------------

/**
 * A successful trajectory observation — the evidence a governed
 * execution completed successfully: the decision record that
 * governed it, the verification authority's own measurement, the
 * observed economics, the executor identity, the environment
 * fingerprint, and the raw trajectory digest (provenance).
 */
export interface SuccessfulTrajectory {
  /** Content-derived identity: sha256 over the canonical trajectory form. */
  readonly trajectoryId: string;
  /** The governed execution that ran the work (UUID). */
  readonly executionId: string;
  /** The WORK-049 decision record that governed the execution (its decisionId). */
  readonly decisionRecordId: string;
  /** The closed outcome vocabulary — mining observes `success` only. */
  readonly outcome: "success";
  /** The OBSERVED quality (the verification authority's measurement, [0, 1]). */
  readonly observedQuality: number;
  /** The verification binding (the authority's own evidence identity). */
  readonly verificationId: string;
  /** The verification strategy that measured the outcome (bounded slug). */
  readonly verificationStrategy: string;
  /** The observed cost, integer micro-USD string in [0, 10^18). */
  readonly observedCostMicroUsd: string;
  /** The observed latency, finite non-negative milliseconds. */
  readonly observedLatencyMs: number;
  /** The executor identity (the agent/worker that executed — neutral slug). */
  readonly executorIdentity: string;
  /** The environment the trajectory ran in (WORK-055's typed identity). */
  readonly environment: EnvironmentFingerprint;
  /**
   * The failure-recovery plane's OWN validated attribution, when the
   * successful execution recovered from a failure on its way to
   * success (imported read-only — the exact provenance, never
   * re-implemented).
   */
  readonly recoveryAttribution?: FailureAttribution;
  /** The explicit observed-at instant (RFC3339 — an INPUT, never ambient). */
  readonly observedAt: string;
  /** sha256 over the raw trajectory event bytes the seams persisted. */
  readonly trajectoryDigest: string;
}

/** The trajectory form excluding the derived identity. */
type TrajectoryForm = Omit<SuccessfulTrajectory, "trajectoryId">;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MICRO_USD_PATTERN = /^(0|[1-9][0-9]{0,17})$/;
const VERIFICATION_ID_MAX = 128;
const VERIFICATION_STRATEGY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Total, deterministic validation of a successful-trajectory
 * observation. Fail-closed on every unmet precondition: the outcome
 * must be `success`, the verification binding must be present, the
 * observed numbers must be bounded, the environment must be a valid
 * fingerprint, and the recovery attribution (when present) must be
 * the failure-recovery plane's OWN valid attribution.
 */
export function validateSuccessfulTrajectory(
  value: unknown,
  digest: IrDigestPort,
): SuccessfulTrajectory {
  if (!isRecord(value)) {
    reject("trajectory-shape", "a successful trajectory must be an object");
  }
  const record = value;
  if (typeof record.trajectoryId !== "string" || !SHA256_HEX_PATTERN.test(record.trajectoryId)) {
    reject("trajectory-shape", "trajectoryId must be a sha256 hex digest", {
      got: boundedDetail(String(record.trajectoryId)),
    });
  }
  if (typeof record.executionId !== "string" || !UUID_PATTERN.test(record.executionId)) {
    reject("trajectory-shape", "trajectory executionId must be a UUID", {
      got: boundedDetail(String(record.executionId)),
    });
  }
  if (
    typeof record.decisionRecordId !== "string" ||
    !SHA256_HEX_PATTERN.test(record.decisionRecordId)
  ) {
    reject("trajectory-shape", "trajectory decisionRecordId must be a sha256 hex digest", {
      got: boundedDetail(String(record.decisionRecordId)),
    });
  }
  if (record.outcome !== "success") {
    // Mining observes successes only — everything else is a typed
    // rejection (never a guessed success).
    reject("trajectory-shape", "mining observes successful trajectories only", {
      got: boundedDetail(String(record.outcome)),
    });
  }
  if (
    typeof record.observedQuality !== "number" ||
    !Number.isFinite(record.observedQuality) ||
    record.observedQuality < 0 ||
    record.observedQuality > 1
  ) {
    reject("trajectory-shape", "observed quality must be a probability in [0, 1]", {
      got: boundedDetail(String(record.observedQuality)),
    });
  }
  if (
    typeof record.verificationId !== "string" ||
    record.verificationId.length === 0 ||
    record.verificationId.length > VERIFICATION_ID_MAX
  ) {
    reject("trajectory-shape", "a successful trajectory must carry its verification binding");
  }
  if (
    typeof record.verificationStrategy !== "string" ||
    !VERIFICATION_STRATEGY_PATTERN.test(record.verificationStrategy)
  ) {
    reject("trajectory-shape", "verification strategy must be a bounded neutral slug", {
      got: boundedDetail(String(record.verificationStrategy)),
    });
  }
  if (
    typeof record.observedCostMicroUsd !== "string" ||
    !MICRO_USD_PATTERN.test(record.observedCostMicroUsd)
  ) {
    reject("trajectory-shape", "observed cost must be an integer micro-USD string in [0, 10^18)", {
      got: boundedDetail(String(record.observedCostMicroUsd)),
    });
  }
  if (
    typeof record.observedLatencyMs !== "number" ||
    !Number.isFinite(record.observedLatencyMs) ||
    record.observedLatencyMs < 0
  ) {
    reject("trajectory-shape", "observed latency must be finite non-negative milliseconds", {
      got: boundedDetail(String(record.observedLatencyMs)),
    });
  }
  if (
    typeof record.executorIdentity !== "string" ||
    !AUTHORITY_ID_PATTERN.test(record.executorIdentity)
  ) {
    reject("trajectory-shape", "trajectory executor identity must be a bounded neutral slug", {
      got: boundedDetail(String(record.executorIdentity)),
    });
  }
  const environment = validateEnvironmentFingerprint(record.environment, digest);
  if (record.recoveryAttribution !== undefined) {
    // The failure-recovery plane's OWN total validation — imported
    // read-only (never re-implemented attribution).
    validateFailureAttribution(record.recoveryAttribution, digest);
  }
  if (typeof record.observedAt !== "string" || record.observedAt.length === 0) {
    reject("trajectory-shape", "observedAt must be a non-empty string");
  }
  if (
    typeof record.trajectoryDigest !== "string" ||
    !SHA256_HEX_PATTERN.test(record.trajectoryDigest)
  ) {
    reject("trajectory-shape", "trajectoryDigest must be a sha256 hex digest", {
      got: boundedDetail(String(record.trajectoryDigest)),
    });
  }
  const trajectory = record as unknown as SuccessfulTrajectory;
  // Identity verification: the trajectoryId covers the canonical form
  // (tampered or foreign observations are rejected at read time).
  const form: TrajectoryForm = {
    executionId: trajectory.executionId,
    decisionRecordId: trajectory.decisionRecordId,
    outcome: trajectory.outcome,
    observedQuality: trajectory.observedQuality,
    verificationId: trajectory.verificationId,
    verificationStrategy: trajectory.verificationStrategy,
    observedCostMicroUsd: trajectory.observedCostMicroUsd,
    observedLatencyMs: trajectory.observedLatencyMs,
    executorIdentity: trajectory.executorIdentity,
    environment,
    ...(trajectory.recoveryAttribution === undefined
      ? {}
      : { recoveryAttribution: trajectory.recoveryAttribution }),
    observedAt: trajectory.observedAt,
    trajectoryDigest: trajectory.trajectoryDigest,
  };
  if (!isCanonicalizable(form)) {
    reject("trajectory-shape", "trajectory form is not canonicalizable");
  }
  const computed = digest.sha256Hex(canonicalJson(form));
  if (computed !== trajectory.trajectoryId) {
    reject("trajectory-shape", "trajectory content does not digest to the claimed identity", {
      claimed: trajectory.trajectoryId,
      computed,
    });
  }
  return trajectory;
}

// ---------------------------------------------------------------------------
// The mining corpus
// ---------------------------------------------------------------------------

/**
 * The mining corpus: the successful-trajectory observations of ONE
 * applicability shape, the honest total-execution denominator, and
 * the independent mining authority identity.
 */
export interface MiningCorpus {
  /** The tenant scope the mining runs under. */
  readonly scope: TenantCacheScope;
  /** The applicability capability being mined (neutral slug). */
  readonly capabilityId: string;
  /** The applicability tags being mined (bounded neutral slugs). */
  readonly tags: readonly string[];
  /** The observed successful trajectories ([2, 256] of them). */
  readonly trajectories: readonly SuccessfulTrajectory[];
  /**
   * The total executions observed for this shape (>= the successful
   * count — the honest reliability denominator, an input never
   * invented).
   */
  readonly totalExecutions: number;
  /** The mining authority identity (NEVER a trajectory executor). */
  readonly miningAuthority: string;
  /** The explicit mining basis (bounded source attribution). */
  readonly basis: string;
}

/** The frozen mining-basis statement. */
export const MINING_BASIS =
  "mining-observes-never-decides;success-only;repetition-minimum-enforced;conservative-evidence-min-quality-max-cost;independent-mining-authority;candidate-stage-only";

// ---------------------------------------------------------------------------
// Mining (the pure observation → candidate-record derivation)
// ---------------------------------------------------------------------------

/**
 * Mine a CANDIDATE competence record from the observed successful
 * trajectories. Pure and deterministic: the same corpus always
 * produces the byte-identical candidate record (the same
 * recordId — IDENTITY-IDEMPOTENCY).
 *
 * Fail-closed BEFORE the record exists:
 *  - every trajectory must be a valid successful observation;
 *  - every trajectory must share the applicability shape's
 *    environment (mixed environments are incoherent mining inputs);
 *  - the repetition minimum must hold (`insufficient-repetition`);
 *  - the reliability denominator must be honest (>= the successes);
 *  - the mining authority must differ from every executor
 *    (self-mining is the self-assertion guard's input side);
 *  - the record-level construction discipline applies WHOLESALE
 *    (buildCompetenceRecord's total validation).
 *
 * The output stage is ALWAYS `candidate`: mining never promotes.
 */
export function mineCompetenceCandidate(
  corpus: MiningCorpus,
  digest: IrDigestPort,
): CompetenceRecord {
  validateTenantCacheScope(corpus.scope);
  if (
    typeof corpus.capabilityId !== "string" ||
    !CAPABILITY_REF_PATTERN.test(corpus.capabilityId)
  ) {
    reject("mining-input-shape", "the mining corpus must carry a bounded capability slug", {
      got: boundedDetail(String(corpus.capabilityId)),
    });
  }
  if (!Array.isArray(corpus.tags) || corpus.tags.length === 0) {
    reject("mining-input-shape", "the mining corpus must declare at least one tag");
  }
  for (const tag of corpus.tags) {
    if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
      reject("mining-input-shape", "mining corpus tags must be bounded neutral slugs", {
        got: boundedDetail(String(tag)),
      });
    }
  }
  if (
    typeof corpus.miningAuthority !== "string" ||
    !AUTHORITY_ID_PATTERN.test(corpus.miningAuthority)
  ) {
    reject("mining-input-shape", "the mining corpus must carry its mining authority identity", {
      got: boundedDetail(String(corpus.miningAuthority)),
    });
  }
  if (typeof corpus.basis !== "string" || corpus.basis.length === 0 || corpus.basis.length > 200) {
    reject("mining-input-shape", "the mining corpus must carry its explicit basis", {
      got: boundedDetail(String(corpus.basis)),
    });
  }
  if (!Array.isArray(corpus.trajectories) || corpus.trajectories.length === 0) {
    reject("mining-input-shape", "the mining corpus must carry its observed trajectories");
  }
  if (corpus.trajectories.length > MAX_MINING_TRAJECTORIES) {
    reject("mining-input-shape", "the mining corpus exceeds the trajectory bound", {
      bound: MAX_MINING_TRAJECTORIES,
      got: corpus.trajectories.length,
    });
  }
  if (corpus.trajectories.length < MIN_SUCCESSFUL_TRAJECTORIES) {
    // The repetition discipline: single lucky runs never become
    // competence — the typed rejection carries the minimum.
    reject("mining-input-shape", "the repetition evidence is below the mining minimum", {
      minimum: MIN_SUCCESSFUL_TRAJECTORIES,
      got: corpus.trajectories.length,
    });
  }
  if (
    typeof corpus.totalExecutions !== "number" ||
    !Number.isInteger(corpus.totalExecutions) ||
    corpus.totalExecutions < corpus.trajectories.length
  ) {
    reject(
      "mining-input-shape",
      "the total-execution denominator must be an integer >= successes",
      {
        totalExecutions: boundedDetail(String(corpus.totalExecutions)),
        successes: corpus.trajectories.length,
      },
    );
  }

  const validated = corpus.trajectories.map((trajectory) =>
    validateSuccessfulTrajectory(trajectory, digest),
  );
  const first = validated[0];
  if (first === undefined) {
    reject("mining-input-shape", "the mining corpus must carry its observed trajectories");
  }

  // Environment coherence: ONE shape means ONE environment. A mixed
  // corpus is an incoherent mining input (typed, never averaged).
  const environmentId = first.environment.fingerprintId;
  for (const trajectory of validated) {
    if (trajectory.environment.fingerprintId !== environmentId) {
      reject(
        "mining-input-shape",
        "the mining corpus mixes environments (one shape = one environment)",
        {
          firstEnvironment: environmentId,
          offending: trajectory.trajectoryId,
        },
      );
    }
  }

  // The self-mining guard (the input side of LEARNING-NONAUTHORITY):
  // the mining authority must be independent of every executor.
  const executors: string[] = [];
  const seenExecutors = new Set<string>();
  for (const trajectory of validated) {
    if (!seenExecutors.has(trajectory.executorIdentity)) {
      seenExecutors.add(trajectory.executorIdentity);
      executors.push(trajectory.executorIdentity);
    }
  }
  if (executors.includes(corpus.miningAuthority)) {
    reject(
      "mining-input-shape",
      "the mining authority executed one of the trajectories (self-mining is rejected)",
      { miningAuthority: corpus.miningAuthority },
    );
  }

  // The trajectory evidence digest: sha256 over the canonical
  // trajectory forms (the exact bytes the record's
  // trajectoryDigest pins — EXECUTION-PROVENANCE).
  const trajectoryEvidence = validated.map((trajectory) => {
    const form: Record<string, unknown> = {
      executionId: trajectory.executionId,
      decisionRecordId: trajectory.decisionRecordId,
      outcome: trajectory.outcome,
      observedQuality: trajectory.observedQuality,
      verificationId: trajectory.verificationId,
      verificationStrategy: trajectory.verificationStrategy,
      observedCostMicroUsd: trajectory.observedCostMicroUsd,
      observedLatencyMs: trajectory.observedLatencyMs,
      executorIdentity: trajectory.executorIdentity,
      environment: trajectory.environment,
      ...(trajectory.recoveryAttribution === undefined
        ? {}
        : { recoveryAttribution: trajectory.recoveryAttribution }),
      observedAt: trajectory.observedAt,
      trajectoryDigest: trajectory.trajectoryDigest,
    };
    return form;
  });
  const trajectoryDigest = digest.sha256Hex(canonicalJson(trajectoryEvidence));

  // Conservative evidence derivation (never self-raised):
  const minQuality = Math.min(...validated.map((t) => t.observedQuality));
  const maxCost = validated.reduce(
    (max, t) => (t.observedCostMicroUsd > max ? t.observedCostMicroUsd : max),
    first.observedCostMicroUsd,
  );
  const maxLatency = Math.max(...validated.map((t) => t.observedLatencyMs));
  const reliability = validated.length / corpus.totalExecutions;

  return buildCompetenceRecord({
    scope: corpus.scope,
    capabilityId: corpus.capabilityId,
    tags: [...new Set(corpus.tags)],
    environment: first.environment,
    trajectoryDigest,
    trajectoryExecutors: executors,
    minedBy: corpus.miningAuthority,
    expectedOutcome: {
      observationCount: validated.length,
      expectedQuality: minQuality,
      expectedReliability: reliability,
      verificationBinding: {
        strategy: first.verificationStrategy,
        verificationId: first.verificationId,
      },
      basis: corpus.basis,
    },
    claim: {
      expectedCostMicroUsd: maxCost,
      expectedLatencyMs: maxLatency,
      expectedQuality: minQuality,
      expectedReliability: reliability,
      basis: {
        basis: "observed",
        source:
          `competence-economics:mining;${MINING_BASIS};trajectories=${validated.length};total=${corpus.totalExecutions};decision-records=${validated.map((t) => t.decisionRecordId).join("+")}`.slice(
            0,
            200,
          ),
        evidenceDigest: trajectoryDigest,
      },
    },
    stage: "candidate",
    digest,
  });
}
