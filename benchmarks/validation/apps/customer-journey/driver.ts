/**
 * The customer-journey engine (VAL-050, the app-local driver — the
 * work order's allowed surface ONLY).
 *
 * THE JOURNEY MACHINERY: the mechanical engine over the declared
 * journey shape — the deterministic journey observation (the stages'
 * durable executions, their recorded economics and their executing
 * identities) and the five mechanical integrity oracles (the spec's
 * verification core):
 *
 *   * STAGE COMPLETENESS — every declared stage present exactly once,
 *     in order; a journey missing a stage FAILs with the stage NAMED
 *     (a dropped stage also drops its cost — the accounting oracle
 *     names the residual);
 *   * CROSS-STAGE IDEMPOTENCY — every submitted intent lands exactly
 *     one durable execution: an orphaned intent (submitted, never
 *     landed) or an undeclared intent FAILs NAMED;
 *   * CONTINUATION EXACTLY-ONCE — a declared mid-journey failure
 *     resumes EXACTLY ONCE (the failed stage lands exactly two
 *     durable executions: the failed attempt plus one resume); an
 *     undeclared resume or a duplicated resume FAILs NAMED;
 *   * CUSTOMER BOUNDARY — every stage executes under the journey's
 *     own customer identity; a stage under any other identity is a
 *     cross-tenant leak and FAILs NAMED;
 *   * ACCOUNTING RECONCILIATION — the journey's end-to-end accounting
 *     reconciles stage-for-stage against the recorded stage economics
 *     (the VAL-049 carried cost basis): each observed stage's
 *     economics must equal its declared recorded economics, and the
 *     reported journey total must equal the stage-for-stage sum — an
 *     unexplained journey-level residual FAILs with the residual
 *     NAMED.
 *
 * The stages replay RECORDED workloads — the observation's economics
 * are pure derivations over the RECORDED basis (never a
 * re-measurement, never a re-pricing; the live row's economics are
 * MEASURED on the live rail, never fabricated here).
 *
 * The digest discipline: the house FNV-1a convention
 * (`economicDigestOf`, imported from the VAL-040 driver — never
 * re-implemented); every evidence reference is digest-only, payload
 * bytes never appear.
 */

import type { LabVerificationCriterion } from "../../platform/derive";
import { economicDigestOf } from "../economic-baseline/driver";
import {
  type CustomerJourneyCorpusRow,
  JOURNEY_CUSTOMER_APPLICATION_ID,
  type JourneyProbeKind,
  type JourneyStageKind,
  type JourneyVerdictKind,
} from "./corpus";

/** The foreign identity the boundary-leak probe executes under (the leak shape). */
export const FOREIGN_APPLICATION_ID = "app-other-customer";

/** One stage's durable-execution record (the journey observation member). */
export interface JourneyStageRecord {
  readonly stage: JourneyStageKind;
  /** The intent this stage executes (one intent per stage, submitted at the intent stage). */
  readonly intentId: string;
  /** The durable execution the stage's intent landed ("" when orphaned). */
  readonly executionId: string;
  /** How many durable executions the stage landed (1; 2 when resumed exactly once). */
  readonly executions: number;
  readonly replayed: boolean;
  /** Whether the stage's record includes a resumed attempt (a mid-journey failure resumed). */
  readonly resumed: boolean;
  /** The identity the stage executed under (the customer-boundary basis). */
  readonly applicationId: string;
  /** The observed stage cost (microUsd — the recorded basis, derived never measured). */
  readonly costMicroUsd: string;
  /** The observed stage latency (ms — the recorded basis). */
  readonly latencyMs: number;
  /** The carried VAL-049 basis anchor (digest-only). */
  readonly basisDigest: string;
}

/** The journey's end-to-end accounting (the reported totals). */
export interface JourneyAccounting {
  readonly totalCostMicroUsd: string;
  readonly totalLatencyMs: number;
}

/** The journey observation (the result read's journey package). */
export interface JourneyObservation {
  readonly rowId: string;
  /** The submitted intents (the intent stage's submission record). */
  readonly submittedIntents: readonly string[];
  readonly stages: readonly JourneyStageRecord[];
  readonly reported: JourneyAccounting;
  /** The journey digest over the stage identities (payload-free). */
  readonly journeyDigest: string;
  /** The measured usage (the live rail only; honestly null offline). */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/** The derived journey verdict (never a narrative). */
export interface JourneyVerdict {
  readonly verdict: JourneyVerdictKind;
  /** The criteria a JOURNEY-FAILED verdict NAMED (empty otherwise). */
  readonly failedCriteria: readonly string[];
}

/** The intent id of one stage (the submission vocabulary). */
export function journeyIntentIdOf(rowId: string, stage: JourneyStageKind): string {
  return `${rowId}:${stage}#intent`;
}

// ---------------------------------------------------------------------------
// The deterministic journey observation (the recorded-basis derivation)
// ---------------------------------------------------------------------------

/**
 * Derive one row's deterministic journey observation (PURE — the
 * recorded-basis derivation over the declared shape; the adversarial
 * probe variants denature the honest trace exactly as the work
 * order's discrimination battery demands: a dropped stage, an
 * orphaned state, a double-driven resume, a boundary leak, a hidden
 * residual).
 */
export function journeyObservationFor(
  row: CustomerJourneyCorpusRow,
  options?: { readonly probe?: JourneyProbeKind },
): JourneyObservation {
  const probe = options?.probe ?? row.probe?.kind ?? null;
  const failureStage = row.midJourneyFailureStage ?? null;
  const honestStages = row.stages.map((declaration) => {
    const declaredDrives = failureStage === declaration.stage ? 2 : 1;
    // The duplicated-resume probe adds ONE extra drive of the
    // daily-usage stage beyond its declared allowance — over a row
    // WITH a declared mid-journey failure that is a resume driven
    // twice (three executions); over a row WITHOUT one it is an
    // UNDECLARED resume (two executions). Both shapes FAIL the
    // continuation oracle NAMED.
    const extraDrive =
      probe === "double-driven-resume" && declaration.stage === "daily-usage" ? 1 : 0;
    const drives = declaredDrives + extraDrive;
    const orphaned = probe === "orphaned-state" && declaration.stage === "daily-usage";
    // The observed economics are derived from the recorded basis at the
    // stage's unit rate (a duplicated resume drives the unit work again —
    // its cost is never hidden; the accounting oracle names the residual).
    const unitCost = BigInt(declaration.economics.costMicroUsd) / BigInt(declaredDrives);
    const unitLatency = declaration.economics.latencyMs / declaredDrives;
    return {
      stage: declaration.stage,
      intentId: journeyIntentIdOf(row.rowId, declaration.stage),
      executionId: orphaned ? "" : `journey-exec-${row.rowId}-${declaration.stage}`,
      executions: orphaned ? 0 : drives,
      replayed: false,
      resumed: !orphaned && drives > 1,
      applicationId:
        probe === "boundary-leak" && declaration.stage === "daily-usage"
          ? FOREIGN_APPLICATION_ID
          : JOURNEY_CUSTOMER_APPLICATION_ID,
      costMicroUsd: orphaned ? "0" : (unitCost * BigInt(drives)).toString(),
      latencyMs: orphaned ? 0 : unitLatency * drives,
      basisDigest: declaration.economics.basisDigest,
    } satisfies JourneyStageRecord;
  });
  const stages =
    probe === "dropped-stage"
      ? honestStages.filter((record) => record.stage !== "daily-usage")
      : honestStages;
  // The dishonest dropped-stage journey drops the stage's intent
  // submission too (the silently dropped stage pretends never declared —
  // the stage-completeness oracle catches it against the row's OWN
  // declaration of record, and the accounting oracle names the missing
  // stage cost as the journey-level residual).
  const submittedIntents = (
    probe === "dropped-stage"
      ? row.stages.filter((declaration) => declaration.stage !== "daily-usage")
      : row.stages
  ).map((declaration) => journeyIntentIdOf(row.rowId, declaration.stage));
  const observedCostTotal = stages.reduce(
    (total, record) => total + BigInt(record.costMicroUsd),
    0n,
  );
  const observedLatencyTotal = stages.reduce((total, record) => total + record.latencyMs, 0);
  // The residual-hiding probe reports a total that hides half the
  // daily-usage stage's observed cost (the unexplained residual).
  const hiddenResidual =
    probe === "residual-hiding"
      ? BigInt(stages.find((record) => record.stage === "daily-usage")?.costMicroUsd ?? "0") / 2n
      : 0n;
  const observation: JourneyObservation = {
    rowId: row.rowId,
    submittedIntents,
    stages,
    reported: {
      totalCostMicroUsd: (observedCostTotal - hiddenResidual).toString(),
      totalLatencyMs: observedLatencyTotal,
    },
    journeyDigest: economicDigestOf({
      rowId: row.rowId,
      stages: stages.map((record) => `${record.stage}:${record.executions}`),
    }),
    usage: null,
  };
  return observation;
}

// ---------------------------------------------------------------------------
// The five mechanical integrity oracles (PURE — the verification core)
// ---------------------------------------------------------------------------

/**
 * Verify one journey observation against its declared row (PURE): the
 * five mechanical integrity criteria — stage completeness, cross-stage
 * idempotency, continuation exactly-once, customer boundary and
 * accounting reconciliation — each FAILing with the violating stage,
 * intent or residual NAMED.
 */
export function verifyCustomerJourneyIntegrity(input: {
  readonly row: CustomerJourneyCorpusRow;
  readonly observation: JourneyObservation;
}): readonly LabVerificationCriterion[] {
  const { row, observation } = input;
  const declared = row.stages.map((declaration) => declaration.stage);
  const observed = observation.stages.map((record) => record.stage);
  const criteria: LabVerificationCriterion[] = [];

  // 1. STAGE COMPLETENESS — every declared stage present exactly
  //    once, in order (a dropped or reordered stage FAILs NAMED).
  const missing = declared.filter((stage) => !observed.includes(stage));
  const extra = observed.filter((stage) => !declared.includes(stage));
  const inOrder =
    declared.length === observed.length &&
    declared.every((stage, index) => observed[index] === stage);
  const duplicated = new Set(observed).size !== observed.length;
  criteria.push({
    criterionId: "stage-completeness",
    strategy: "deterministic",
    status: missing.length === 0 && extra.length === 0 && inOrder && !duplicated ? "PASS" : "FAIL",
    evidence: [
      `declared-stages:${declared.join(">")}`,
      `observed-stages:${observed.join(">") || "none"}`,
      ...(missing.length === 0 ? [] : [`missing-stage:${missing.join(",")}`]),
      ...(extra.length === 0 ? [] : [`undeclared-stage:${extra.join(",")}`]),
      ...(inOrder || missing.length > 0 || extra.length > 0 ? [] : ["stage-order-divergence"]),
      ...(duplicated ? ["duplicated-stage-record"] : []),
    ],
  });

  // 2. CROSS-STAGE IDEMPOTENCY — every submitted intent lands exactly
  //    one durable execution (no orphaned intent, no undeclared
  //    intent, no unlanded submission).
  const orphaned = observation.stages.filter((record) => record.executionId === "");
  const unclaimed = observation.submittedIntents.filter(
    (intentId) => !observation.stages.some((record) => record.intentId === intentId),
  );
  const undeclared = observation.stages.filter(
    (record) => !observation.submittedIntents.includes(record.intentId),
  );
  criteria.push({
    criterionId: "cross-stage-idempotency",
    strategy: "deterministic",
    status:
      orphaned.length === 0 && unclaimed.length === 0 && undeclared.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `submitted-intents:${observation.submittedIntents.length}`,
      `landed-executions:${observation.stages.filter((record) => record.executionId !== "").length}`,
      ...(orphaned.length === 0
        ? []
        : orphaned.map((record) => `orphaned-intent:${record.stage} (${record.intentId})`)),
      ...(unclaimed.length === 0 ? [] : [`unclaimed-intent:${unclaimed.join(",")}`]),
      ...(undeclared.length === 0
        ? []
        : undeclared.map((record) => `undeclared-intent:${record.stage} (${record.intentId})`)),
    ],
  });

  // 3. CONTINUATION EXACTLY-ONCE — a declared mid-journey failure
  //    resumes EXACTLY ONCE (the failed stage lands exactly two
  //    durable executions); an undeclared resume or a duplicated
  //    resume FAILs NAMED. (An intent that never landed a durable
  //    execution is the idempotency oracle's catch — an orphaned
  //    stage is skipped here, never double-counted.)
  const failureStage = row.midJourneyFailureStage ?? null;
  const badResumes = observation.stages.filter((record) => {
    if (record.executionId === "") {
      return false;
    }
    const declaredFailure = failureStage === record.stage;
    const expectedExecutions = declaredFailure ? 2 : 1;
    return record.executions !== expectedExecutions || record.resumed !== declaredFailure;
  });
  criteria.push({
    criterionId: "continuation-exactly-once",
    strategy: "deterministic",
    status: badResumes.length === 0 ? "PASS" : "FAIL",
    evidence: [
      ...(failureStage === null
        ? ["declared-failure-stage:none"]
        : [`declared-failure-stage:${failureStage}`]),
      ...observation.stages.map(
        (record) => `${record.stage}:executions=${record.executions},resumed=${record.resumed}`,
      ),
      ...(badResumes.length === 0
        ? []
        : badResumes.map(
            (record) =>
              `resume-violation:${record.stage} (observed executions=${record.executions}, resumed=${record.resumed}; expected exactly ${
                failureStage === record.stage
                  ? "2 (one failed attempt plus exactly one resume)"
                  : "1 (no declared failure)"
              })`,
          )),
    ],
  });

  // 4. CUSTOMER BOUNDARY — every stage executes under the journey's
  //    own customer identity (a foreign identity is a cross-tenant leak).
  const leaked = observation.stages.filter(
    (record) => record.applicationId !== JOURNEY_CUSTOMER_APPLICATION_ID,
  );
  criteria.push({
    criterionId: "customer-boundary",
    strategy: "deterministic",
    status: leaked.length === 0 ? "PASS" : "FAIL",
    evidence: [
      `journey-customer:${JOURNEY_CUSTOMER_APPLICATION_ID}`,
      `observed-identities:${new Set(observation.stages.map((record) => record.applicationId)).size}`,
      ...(leaked.length === 0
        ? []
        : leaked.map(
            (record) =>
              `boundary-leak:${record.stage} (executed under ${record.applicationId}, not ${JOURNEY_CUSTOMER_APPLICATION_ID})`,
          )),
    ],
  });

  // 5. ACCOUNTING RECONCILIATION — the end-to-end accounting
  //    reconciles stage-for-stage against the recorded stage
  //    economics: each observed stage's economics equal its declared
  //    recorded economics (digest-anchored to the VAL-049 basis), the
  //    observed stage sum equals the recorded journey total, and the
  //    reported journey total equals the observed stage sum (zero
  //    residual — an unexplained residual FAILs with the amount NAMED).
  const declaredByStage = new Map(
    row.stages.map((declaration) => [declaration.stage, declaration]),
  );
  const repriced = observation.stages.filter((record) => {
    const declaration = declaredByStage.get(record.stage);
    return (
      declaration !== undefined &&
      (record.costMicroUsd !== declaration.economics.costMicroUsd ||
        record.latencyMs !== declaration.economics.latencyMs ||
        record.basisDigest !== declaration.economics.basisDigest)
    );
  });
  const observedCostTotal = observation.stages.reduce(
    (total, record) => total + BigInt(record.costMicroUsd),
    0n,
  );
  const recordedCostTotal = row.stages.reduce(
    (total, declaration) => total + BigInt(declaration.economics.costMicroUsd),
    0n,
  );
  const reportedCostTotal = BigInt(observation.reported.totalCostMicroUsd);
  const costResidual = reportedCostTotal - observedCostTotal;
  const observedLatencyTotal = observation.stages.reduce(
    (total, record) => total + record.latencyMs,
    0,
  );
  const recordedLatencyTotal = row.stages.reduce(
    (total, declaration) => total + declaration.economics.latencyMs,
    0,
  );
  const latencyResidual = observation.reported.totalLatencyMs - observedLatencyTotal;
  criteria.push({
    criterionId: "accounting-reconciliation",
    strategy: "deterministic",
    status:
      repriced.length === 0 &&
      observedCostTotal === recordedCostTotal &&
      costResidual === 0n &&
      observedLatencyTotal === recordedLatencyTotal &&
      latencyResidual === 0
        ? "PASS"
        : "FAIL",
    evidence: [
      `recorded-cost-basis:${recordedCostTotal.toString()}`,
      `observed-stage-sum:${observedCostTotal.toString()}`,
      `reported-journey-total:${reportedCostTotal.toString()}`,
      `cost-residual:${costResidual.toString()}`,
      `recorded-latency-basis:${recordedLatencyTotal}`,
      `observed-latency-sum:${observedLatencyTotal}`,
      `reported-latency-total:${observation.reported.totalLatencyMs}`,
      `latency-residual:${latencyResidual}`,
      ...(repriced.length === 0
        ? []
        : repriced.map((record) => `re-priced-stage:${record.stage} (recorded basis drifted)`)),
    ],
  });

  return criteria;
}

/**
 * Derive the journey verdict over one observation (PURE): all five
 * integrity criteria PASS → JOURNEY-COMPLETED; any FAIL →
 * JOURNEY-FAILED with every failed criterion NAMED.
 */
export function deriveJourneyVerdict(input: {
  readonly row: CustomerJourneyCorpusRow;
  readonly observation: JourneyObservation;
}): JourneyVerdict {
  const criteria = verifyCustomerJourneyIntegrity(input);
  const failedCriteria = criteria
    .filter((criterion) => criterion.status === "FAIL")
    .map((criterion) => criterion.criterionId);
  return {
    verdict: failedCriteria.length === 0 ? "JOURNEY-COMPLETED" : "JOURNEY-FAILED",
    failedCriteria,
  };
}
