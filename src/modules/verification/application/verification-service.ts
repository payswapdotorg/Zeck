/**
 * Verification service (verification module application; WORK-013,
 * VER-001/002/003/004, INT-005).
 *
 * THE governed evaluation path of the verification authority. The
 * service is NOT a planner, NOT a policy engine, NOT a provider and NOT
 * an execution state machine — it is the independent evidence authority
 * that assesses candidate results against DECLARED criteria and reports
 * conclusions:
 *
 * ```text
 * execution (candidate result)
 *   → identity/tenant + execution binding        (executions ledger read)
 *   → [execution-lifecycle mode] verify edge     (executions authority)
 *   → POLICY admission                           (REQUIRED seam — the
 *                                                  WORK-007 engine decides)
 *   → durable evaluation intent                  (journal row +
 *                                                  execution.verification-
 *                                                  requested ledger event)
 *   → criteria resolution                        (declared criteria only)
 *   → target resolution                          (optional fail-closed
 *                                                  resolvers: artifacts,
 *                                                  plan revisions)
 *   → evaluation, deterministic-first            (kind-bound evaluator
 *                                                  selection; model judge
 *                                                  separately admitted
 *                                                  before its dispatch;
 *                                                  human-judged → mediated
 *                                                  request path)
 *   → durable results                            (immutable, revision/
 *                                                  provenance-bound +
 *                                                  execution.verification-
 *                                                  recorded ledger event)
 *   → conclusion                                 (required criteria all
 *                                                  revision-matching PASS
 *                                                  ⇔ criteriaMet —
 *                                                  INCONCLUSIVE is NEVER
 *                                                  acceptance)
 *   → pass transition (criteria met; the ONLY transition this module
 *     issues — completion is produced by /verification, spec/contracts.md)
 *     OR replanning boundary report (unmet — the PLANNER decides)
 * ```
 *
 * Authority preservation (the "no second authority" discipline):
 *   - policy: decided ONLY by the REQUIRED `admission` seam; no
 *     default-allow exists — a missing/denying authority fails closed
 *     before any evaluator runs;
 *   - execution lifecycle: the ONLY transitions issued are `verify` and
 *     `pass`, THROUGH the executions authority port; replan/fail/
 *     wait-human belong to the planner/orchestrator (the Replanning-
 *     Boundary port reports; the boundary decides);
 *   - evidence: every result rides the canonical executions ledger
 *     through the REQUIRED `ledger` seam (step events) and is durable
 *     in the verification store (append-only);
 *   - providers: model judges dispatch through the models module's
 *     adapters behind the ModelJudge port; provider identity is recorded
 *     as EVIDENCE, never authority;
 *   - determinism-first: deterministic criteria kinds are established by
 *     deterministic evaluators only (evaluator selection is kind-bound —
 *     a hidden AI call cannot replace deterministic verification).
 *
 * Idempotency (`spec/contracts.md` idempotency response rule): every
 * mutating operation carries a caller idempotency key; the durable
 * journal row (evaluation/request/comparison) keyed by (application,
 * key) IS the outcome — same key + same fingerprint replays, same key +
 * different fingerprint fails `IDEMPOTENCY_KEY_REUSED`, concurrent
 * duplicates converge through the store's unique-index arbitration.
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type { VerificationResultInput } from "../../executions/public";
import type {
  CandidateComparisonRecord,
  ComparisonCandidate,
  PlannerAuthorization,
} from "../domain/comparison";
import { validateComparison, validatePlannerAuthorization } from "../domain/comparison";
import type { VerificationConclusion } from "../domain/conclusion";
import { deriveConclusion } from "../domain/conclusion";
import type { VerificationCriteria } from "../domain/criteria";
import { validateCriteriaDeclaration } from "../domain/criteria";
import type { Evaluator, EvidenceBundle } from "../domain/evaluator";
import { selectEvaluator } from "../domain/evaluator";
import type { HumanDecisionInput, HumanEvaluationRequestRecord } from "../domain/human";
import { validateHumanDecision } from "../domain/human";
import type {
  VerificationPolicyEvidence,
  VerificationResultRecord,
  VerificationTarget,
} from "../domain/result";
import { validateResult } from "../domain/result";
import type { ReplanningBoundary } from "../ports/replanning-boundary";
import { replanningOutcomeOf } from "../ports/replanning-boundary";
import type { TargetResolution, TargetResolver } from "../ports/target-resolvers";
import type { VerificationAdmission } from "../ports/verification-admission";
import type {
  ExecutionPassInput,
  ExecutionTransitionPort,
  VerificationLedger,
} from "../ports/verification-ledger";
import type { EvaluationJournalRecord, VerificationStore } from "../ports/verification-store";

const KEY_PATTERN = /^[!-~]{1,200}$/;

/** Deterministic canonical JSON (sorted keys) for fingerprints. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => [key, canonical(record[key])]);
  }
  return value;
}

export interface VerificationServiceDeps {
  readonly store: VerificationStore;
  /** REQUIRED policy admission seam — no default-allow exists by design. */
  readonly admission: VerificationAdmission;
  /** REQUIRED canonical execution evidence path. */
  readonly ledger: VerificationLedger;
  /** REQUIRED execution lifecycle authority (verify/pass edges only). */
  readonly transitions: ExecutionTransitionPort;
  /**
   * The replanning authority seam. OPTIONAL wiring: when absent, an unmet
   * outcome is honestly reported to the caller (never silently accepted);
   * when present, the planner's decision is recorded as evidence.
   */
  readonly replanning?: ReplanningBoundary;
  /** The registered evaluator adapters (deterministic + model + mediated human). */
  readonly evaluators: readonly Evaluator[];
  /** Optional fail-closed target resolvers keyed by target kind. */
  readonly resolvers?: Readonly<Partial<Record<string, TargetResolver>>>;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** One-way digest of the canonical request (idempotency fingerprints). */
  readonly hashInput: (canonicalText: string) => string;
}

export interface VerificationActor {
  readonly actorId: string;
  readonly tenantId: string;
}

export interface CriteriaRef {
  readonly criterionId: string;
  readonly version: number;
}

export interface VerifyExecutionInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: VerificationActor;
  readonly criteria: readonly CriteriaRef[];
  /** Evidence about the execution's candidate result (facts + durable refs). */
  readonly evidence: {
    readonly facts: Readonly<Record<string, unknown>>;
    readonly evidenceRefs: readonly string[];
  };
  readonly cause?: string;
}

export interface VerifyTargetInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: VerificationActor;
  readonly target: {
    readonly kind: "plan-revision" | "artifact" | "tool-output" | "model-output" | "record";
    readonly ref: string;
    readonly revision?: string;
  };
  readonly criteria: readonly CriteriaRef[];
  readonly evidence: {
    readonly facts: Readonly<Record<string, unknown>>;
    readonly evidenceRefs: readonly string[];
  };
  readonly cause?: string;
}

export interface RequestHumanEvaluationInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: VerificationActor;
  readonly target: {
    readonly kind:
      | "plan-revision"
      | "artifact"
      | "tool-output"
      | "model-output"
      | "record"
      | "execution-output";
    readonly ref: string;
    readonly revision?: string;
  };
  readonly criterionId: string;
  readonly criteriaVersion: number;
  readonly question: string;
  readonly evidenceRefs?: readonly string[];
  readonly cause?: string;
}

export interface CompareCandidatesInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: VerificationActor;
  readonly criterionId: string;
  readonly criteriaVersion: number;
  readonly candidates: readonly ComparisonCandidate[];
  readonly plannerAuthorization: PlannerAuthorization;
  readonly cause?: string;
}

export interface HumanDecisionOutcome {
  readonly request: HumanEvaluationRequestRecord;
  readonly result: VerificationResultRecord;
  readonly replayed: boolean;
}

export interface VerificationService {
  declareCriteria(input: {
    applicationId: string;
    tenantId: string;
    criteria: VerificationCriteria;
  }): Promise<{ converged: boolean }>;
  verifyExecution(
    input: VerifyExecutionInput,
    idempotencyKey: string,
  ): Promise<VerificationConclusion>;
  verifyTarget(input: VerifyTargetInput, idempotencyKey: string): Promise<VerificationConclusion>;
  requestHumanEvaluation(
    input: RequestHumanEvaluationInput,
    idempotencyKey: string,
  ): Promise<{ request: HumanEvaluationRequestRecord; replayed: boolean }>;
  submitHumanDecision(
    input: HumanDecisionInput,
    idempotencyKey: string,
  ): Promise<HumanDecisionOutcome>;
  compareCandidates(
    input: CompareCandidatesInput,
    idempotencyKey: string,
  ): Promise<{ comparison: CandidateComparisonRecord; replayed: boolean }>;
  listResults(
    applicationId: string,
    executionId: string,
  ): Promise<readonly VerificationResultRecord[]>;
  getEvaluation(
    applicationId: string,
    evaluationKey: string,
  ): Promise<EvaluationJournalRecord | null>;
}

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"] as const;

function requireKey(idempotencyKey: string, operation: string): void {
  if (typeof idempotencyKey !== "string" || !KEY_PATTERN.test(idempotencyKey)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: `${operation} requires a non-empty printable idempotency key (max 200 chars)`,
    });
  }
}

function requireScope(input: {
  applicationId?: unknown;
  executionId?: unknown;
  actor?: unknown;
}): void {
  if (typeof input.applicationId !== "string" || !isUuid(input.applicationId)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "verification requires a valid applicationId",
    });
  }
  if (typeof input.executionId !== "string" || !isUuid(input.executionId)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "verification requires a valid executionId (the parent execution)",
    });
  }
  const actor = input.actor as VerificationActor | undefined;
  if (
    actor === null ||
    typeof actor !== "object" ||
    !isUuid(actor?.actorId) ||
    !isUuid(actor?.tenantId)
  ) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "verification requires a server-derived actor scope",
    });
  }
}

function requireCriteriaRefs(criteria: readonly CriteriaRef[]): void {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "verification requires at least one criteria reference (criteria are mandatory)",
    });
  }
  for (const ref of criteria) {
    if (
      typeof ref?.criterionId !== "string" ||
      ref.criterionId.length === 0 ||
      typeof ref?.version !== "number" ||
      !Number.isInteger(ref.version) ||
      ref.version < 1
    ) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "each criteria reference needs a criterionId and a positive integer version",
      });
    }
  }
}

function policyDenied(reason: string, details?: Readonly<Record<string, unknown>>): PlatformError {
  return new PlatformError({ code: "POLICY_DENIED", message: reason, details });
}

export function createVerificationService(deps: VerificationServiceDeps): VerificationService {
  const { store, admission, ledger, transitions, replanning, evaluators, resolvers } = deps;
  const generateId = deps.generateId;
  const now = deps.now;
  const hashInput = deps.hashInput;

  // In-process single-flight per (application, idempotency key): concurrent
  // identical requests share ONE in-flight evaluation and its durable
  // outcome (spec/contracts.md: "Concurrent identical requests converge to
  // one durable identity" — the unique-index arbitration owns durability
  // across processes; this closes the in-process duplicate-result window).
  const inFlight = new Map<string, Promise<unknown>>();

  const iso = () => now().toISOString();
  const fingerprintOf = (parts: unknown): string => hashInput(JSON.stringify(canonical(parts)));

  // -------------------------------------------------------------------------
  // Shared: execution binding (identity/tenant + terminal discipline).
  // -------------------------------------------------------------------------
  async function bindExecution(applicationId: string, executionId: string, tenantId: string) {
    const execution = await ledger.getExecution(applicationId, executionId);
    if (execution === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "execution not found in this application (missing or owned by another application)",
        details: { executionId },
      });
    }
    if (execution.tenantId !== tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution belongs to a different tenant",
        details: { executionId },
      });
    }
    if ((TERMINAL_STATUSES as readonly string[]).includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no verification may run on it`,
        details: { executionId, status: execution.status },
      });
    }
    return execution;
  }

  // -------------------------------------------------------------------------
  // Shared: criteria resolution (DECLARED criteria only — an undeclared
  // criterion can never gate anything; M21's input half).
  // -------------------------------------------------------------------------
  async function resolveCriteria(
    applicationId: string,
    refs: readonly CriteriaRef[],
  ): Promise<readonly VerificationCriteria[]> {
    const resolved: VerificationCriteria[] = [];
    for (const ref of refs) {
      const criteria = await store.findCriteria(applicationId, ref.criterionId, ref.version);
      if (criteria === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `criterion ${ref.criterionId}@${ref.version} is not declared (verification requires declared criteria)`,
          details: { criterionId: ref.criterionId, version: ref.version },
        });
      }
      resolved.push(criteria);
    }
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Shared: fail-closed target resolution (M11/M12 input half).
  // -------------------------------------------------------------------------
  async function resolveTarget(input: {
    tenantId: string;
    applicationId: string;
    executionId: string;
    target: { kind: string; ref: string; revision?: string };
  }): Promise<void> {
    const resolver = resolvers?.[input.target.kind];
    if (resolver === undefined) {
      return;
    }
    const resolution: TargetResolution = await resolver.resolveTarget({
      tenantId: input.tenantId,
      applicationId: input.applicationId,
      executionId: input.executionId,
      target: input.target as Parameters<TargetResolver["resolveTarget"]>[0]["target"],
    });
    if (!resolution.resolved) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: `verification target does not resolve in scope: ${resolution.reason}`,
        details: { kind: input.target.kind, ref: input.target.ref },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Shared: the deterministic-first evaluation of one criterion set.
  // -------------------------------------------------------------------------
  interface EvaluationRunInput {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
    readonly actorId: string;
    readonly evaluationId: string;
    readonly target: { kind: string; ref: string; revision?: string };
    readonly criteria: readonly VerificationCriteria[];
    readonly evidence: EvidenceBundle;
    readonly policyEvidence?: VerificationPolicyEvidence;
    readonly cause?: string;
    /** The human-decision results already durable for this target. */
    readonly priorHumanResults: readonly VerificationResultRecord[];
  }

  async function runEvaluation(
    run: EvaluationRunInput,
  ): Promise<readonly VerificationResultRecord[]> {
    const results: VerificationResultRecord[] = [];
    const existing = await store.listResults(run.applicationId, run.executionId);

    for (const criteria of run.criteria) {
      if (criteria.kind === "human-judged") {
        // The MEDIATED human path: a prior decision for THIS criterion +
        // target revision is the durable human result; without one, the
        // criterion is honestly INCONCLUSIVE (pending human) and a policy-
        // admitted request is created for it.
        const prior = [
          ...run.priorHumanResults,
          ...existing.filter(
            (result) =>
              result.evaluator.kind === "human" &&
              result.criterionId === criteria.criterionId &&
              result.criteriaVersion === criteria.version &&
              result.target.kind === run.target.kind &&
              result.target.ref === run.target.ref &&
              (run.target.revision === undefined ||
                result.target.revision === undefined ||
                result.target.revision === run.target.revision),
          ),
        ].at(-1);
        if (prior !== undefined) {
          results.push(prior);
          continue;
        }
        const pending = await recordHumanPending(run, criteria);
        results.push(pending);
        continue;
      }

      const evaluator = selectEvaluator(evaluators, criteria.kind);
      if (evaluator === null) {
        // No evaluator can establish this criterion — honest INCONCLUSIVE
        // with an explicit observation (never silently skipped, never
        // reassigned to another evaluator class).
        const result = buildResult(run, criteria, {
          evaluator: { kind: "deterministic", id: "none", version: "0" },
          status: "INCONCLUSIVE",
          observations: [`no registered evaluator establishes criterion kind "${criteria.kind}"`],
          evidenceRefs: run.evidence.evidenceRefs,
        });
        results.push(await persistResult(run, result));
        continue;
      }

      // Per-evaluator policy admission BEFORE the evaluator runs
      // (POLICY-BEFORE-DISPATCH at the evaluator boundary; model judges
      // additionally declare their provider-neutral rail facts).
      const action = criteria.kind === "model-judged" ? "model-evaluation" : "evaluate";
      const decision = await admission.admit({
        action,
        tenantId: run.tenantId,
        applicationId: run.applicationId,
        executionId: run.executionId,
        evaluator: evaluator.identity,
        provider: evaluator.identity.kind === "model" ? evaluator.identity.id : undefined,
      });
      if (!decision.allowed) {
        // Fail closed: the evaluator never runs; the evaluation is denied
        // durably (the journal row) and surfaces POLICY_DENIED.
        await store.denyEvaluation({
          applicationId: run.applicationId,
          evaluationId: run.evaluationId,
          reason: `${action} denied by the effective policy: ${decision.reason}`,
          now: iso(),
        });
        throw policyDenied(
          `verification evaluator for criterion ${criteria.criterionId} denied by the effective policy: ${decision.reason}`,
          { criterionId: criteria.criterionId },
        );
      }

      const outcome = await evaluator.evaluate(
        run.evidence,
        {
          criterionId: criteria.criterionId,
          version: criteria.version,
          kind: criteria.kind,
          definition: criteria.definition,
        },
        {
          applicationId: run.applicationId,
          tenantId: run.tenantId,
          executionId: run.executionId,
          actorId: run.actorId,
        },
      );
      const result = buildResult(run, criteria, {
        evaluator: evaluator.identity,
        status: outcome.status,
        observations: outcome.observations,
        evidenceRefs: outcome.evidenceRefs,
        confidence: outcome.confidence,
      });
      results.push(await persistResult(run, result));
    }
    return results;
  }

  function buildResult(
    run: EvaluationRunInput,
    criteria: VerificationCriteria,
    outcome: {
      evaluator: { kind: "deterministic" | "model" | "human"; id: string; version: string };
      status: "PASS" | "FAIL" | "INCONCLUSIVE";
      observations: readonly string[];
      evidenceRefs: readonly string[];
      confidence?: number;
    },
  ): VerificationResultRecord {
    const evidence = outcome.status === "PASS" ? outcome.evidenceRefs : [...outcome.evidenceRefs];
    const result: VerificationResultRecord = {
      id: generateId(),
      applicationId: run.applicationId,
      tenantId: run.tenantId,
      executionId: run.executionId,
      target: {
        kind: run.target.kind as VerificationResultRecord["target"]["kind"],
        ref: run.target.ref,
        ...(run.target.revision === undefined ? {} : { revision: run.target.revision }),
      },
      criterionId: criteria.criterionId,
      criteriaVersion: criteria.version,
      evaluator: outcome.evaluator,
      status: outcome.status,
      ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
      observations: outcome.observations,
      evidence,
      ...(run.policyEvidence === undefined
        ? {}
        : {
            policyEvidence:
              run.policyEvidence as unknown as VerificationResultRecord["policyEvidence"],
          }),
      provenance: {
        evaluationId: run.evaluationId,
        actorId: run.actorId,
        ...(run.cause === undefined ? {} : { cause: run.cause }),
      },
      recordedBy: `${outcome.evaluator.kind}:${outcome.evaluator.id}@${outcome.evaluator.version}`,
      recordedAt: iso(),
    };
    const validation = validateResult(result);
    if (!validation.ok) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: `verification result for criterion ${criteria.criterionId} is not recordable: ${validation.issues.join("; ")}`,
        details: { issues: validation.issues },
      });
    }
    return result;
  }

  async function persistResult(
    run: EvaluationRunInput,
    result: VerificationResultRecord,
  ): Promise<VerificationResultRecord> {
    const inserted = await store.insertResult({ result });
    // Canonical execution evidence path: every result is bound to the
    // parent execution's ledger (M13 — no writes around the ledger).
    await ledger.recordStepEvent(
      {
        applicationId: run.applicationId,
        executionId: run.executionId,
        actor: { actorId: run.actorId, tenantId: run.tenantId },
        command: "verification-recorded",
        cause: run.cause ?? "verification-result",
        reference: {
          verificationResultId: result.id,
          evaluationId: run.evaluationId,
          criterionId: result.criterionId,
          criteriaVersion: result.criteriaVersion,
          status: result.status,
          evaluator: `${result.evaluator.kind}:${result.evaluator.id}@${result.evaluator.version}`,
          target: { kind: result.target.kind, ref: result.target.ref },
        },
        payload: {
          status: result.status,
          criterionId: result.criterionId,
          evaluatorKind: result.evaluator.kind,
          evidenceCount: result.evidence.length,
          observations: result.observations,
        },
      },
      `${run.evaluationId}:result:${result.id}`,
    );
    return inserted;
  }

  /** The pending-human INCONCLUSIVE record + the policy-gated request. */
  async function recordHumanPending(
    run: EvaluationRunInput,
    criteria: VerificationCriteria,
  ): Promise<VerificationResultRecord> {
    let requestId: string | undefined;
    let observation = "human judgment required (no decision recorded)";
    const decision = await admission.admit({
      action: "human-evaluation",
      tenantId: run.tenantId,
      applicationId: run.applicationId,
      executionId: run.executionId,
    });
    if (decision.allowed) {
      const request: HumanEvaluationRequestRecord = {
        id: generateId(),
        applicationId: run.applicationId,
        tenantId: run.tenantId,
        executionId: run.executionId,
        requestKey: `${run.evaluationId}:human:${criteria.criterionId}`,
        requestFingerprint: fingerprintOf([
          run.evaluationId,
          criteria.criterionId,
          criteria.version,
          run.target.kind,
          run.target.ref,
          run.target.revision ?? null,
        ]),
        target: {
          kind: run.target.kind as HumanEvaluationRequestRecord["target"]["kind"],
          ref: run.target.ref,
          ...(run.target.revision === undefined ? {} : { revision: run.target.revision }),
        },
        criterionId: criteria.criterionId,
        criteriaVersion: criteria.version,
        question:
          typeof criteria.definition.question === "string" &&
          criteria.definition.question.length > 0
            ? criteria.definition.question
            : `Does the evidence satisfy criterion ${criteria.criterionId}?`,
        evidence: run.evidence.evidenceRefs,
        requestedBy: run.actorId,
        ...(decision.evidence === undefined ? {} : { policyEvidence: decision.evidence }),
        requestedAt: iso(),
      };
      await store.insertHumanRequest({ request });
      await ledger.recordStepEvent(
        {
          applicationId: run.applicationId,
          executionId: run.executionId,
          actor: { actorId: run.actorId, tenantId: run.tenantId },
          command: "human-evaluation-requested",
          cause: run.cause ?? "human-judged criterion unresolved",
          reference: {
            humanRequestId: request.id,
            criterionId: criteria.criterionId,
            criteriaVersion: criteria.version,
          },
          payload: { question: request.question, evidenceCount: request.evidence.length },
        },
        `${request.id}:requested`,
      );
      requestId = request.id;
      observation = `human judgment required (request ${request.id} pending)`;
    } else {
      observation = `human judgment required but human evaluation is not permitted by the effective policy (${decision.reason})`;
    }
    const result: VerificationResultRecord = {
      ...buildResult(run, criteria, {
        evaluator: { kind: "human", id: "human-mediated", version: "1" },
        status: "INCONCLUSIVE",
        observations: [observation],
        evidenceRefs: run.evidence.evidenceRefs,
      }),
      provenance: {
        evaluationId: run.evaluationId,
        actorId: run.actorId,
        ...(run.cause === undefined ? {} : { cause: run.cause }),
        ...(requestId === undefined ? {} : { humanRequestId: requestId }),
      },
    };
    return persistResult(run, result);
  }

  // -------------------------------------------------------------------------
  // Shared: conclusion + completion/replan boundary.
  // -------------------------------------------------------------------------
  async function concludeEvaluation(run: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
    readonly actor: VerificationActor;
    readonly evaluationId: string;
    readonly target: { kind: string; ref: string; revision?: string };
    readonly criteria: readonly VerificationCriteria[];
    readonly results: readonly VerificationResultRecord[];
    readonly lifecycle: boolean;
    readonly cause?: string;
  }): Promise<VerificationConclusion> {
    const derived = deriveConclusion({
      results: run.results,
      criteria: run.criteria.map((criteria) => ({
        criterionId: criteria.criterionId,
        version: criteria.version,
        required: criteria.required,
      })),
      targetRevision: run.target.revision,
    });

    let completed = false;
    let replanningDecision: VerificationConclusion["replanningDecision"];

    const base: VerificationConclusion = {
      executionId: run.executionId,
      applicationId: run.applicationId,
      tenantId: run.tenantId,
      evaluationId: run.evaluationId,
      criteriaMet: derived.criteriaMet,
      requiredUnmet: derived.requiredUnmet,
      results: run.results,
      completed: false,
      replayed: false,
    };

    // The unmet outcome is REPORTED to the planner boundary BEFORE any
    // durable finalization (INT-005): the verifier reports; the planner
    // decides. A met outcome skips the boundary entirely.
    if (!derived.criteriaMet && replanning !== undefined) {
      replanningDecision = await replanning.onVerificationOutcome(replanningOutcomeOf(base));
    }

    // Durable conclusion evidence FIRST (journal + canonical ledger
    // envelope) — the completion transition goes LAST because a terminal
    // execution accepts no further ledger events (the executions module's
    // terminal-immutability discipline).
    await store.completeEvaluation({
      applicationId: run.applicationId,
      evaluationId: run.evaluationId,
      conclusion: {
        criteriaMet: derived.criteriaMet,
        requiredUnmet: derived.requiredUnmet,
        ...(replanningDecision === undefined
          ? {}
          : {
              replanningDecision: {
                decision: replanningDecision.decision,
                ...(replanningDecision.detail === undefined
                  ? {}
                  : { detail: replanningDecision.detail }),
              },
            }),
        completed: derived.criteriaMet && run.lifecycle,
      },
      now: iso(),
    });

    // The conclusion envelope on the canonical ledger.
    await ledger.recordStepEvent(
      {
        applicationId: run.applicationId,
        executionId: run.executionId,
        actor: { actorId: run.actor.actorId, tenantId: run.actor.tenantId },
        command: "verification-recorded",
        cause: run.cause ?? "verification-conclusion",
        reference: {
          evaluationId: run.evaluationId,
          criteriaMet: derived.criteriaMet,
          resultIds: run.results.map((result) => result.id),
        },
        payload: {
          criteriaMet: derived.criteriaMet,
          requiredUnmet: derived.requiredUnmet,
          completed: derived.criteriaMet && run.lifecycle,
          replanningDecision: replanningDecision?.decision ?? null,
        },
      },
      `${run.evaluationId}:conclusion`,
    );

    if (derived.criteriaMet && run.lifecycle) {
      // Completion is produced by /verification: drive the pass edge with
      // the durable results (at least one PASS — all required are PASS by
      // construction). The executions authority owns legality/binding.
      const passInput: ExecutionPassInput = {
        executionId: run.executionId,
        applicationId: run.applicationId,
        actor: run.actor,
        ...(run.cause === undefined ? {} : { reason: run.cause }),
        verificationResults: run.results
          .filter(
            (result) =>
              result.status === "PASS" &&
              (run.target.revision === undefined ||
                result.target.revision === undefined ||
                result.target.revision === run.target.revision),
          )
          .map(
            (result): VerificationResultInput => ({
              criterionId: result.criterionId,
              strategy: `verification:${result.evaluator.kind}`,
              status: result.status,
              evidence: [
                `verification:result:${result.id}`,
                ...result.evidence.map((ref) => `evidence:${ref}`),
              ],
              recordedBy: result.recordedBy,
            }),
          ),
      };
      await transitions.pass(passInput, `${run.evaluationId}:pass`);
      completed = true;
    }

    const conclusion: VerificationConclusion = {
      ...base,
      ...(replanningDecision === undefined ? {} : { replanningDecision }),
      completed,
    };

    return conclusion;
  }

  // -------------------------------------------------------------------------
  // Shared: the full governed evaluation flow (journal + idempotency).
  // -------------------------------------------------------------------------
  async function verifyFlow(
    input: VerifyExecutionInput | VerifyTargetInput,
    idempotencyKey: string,
    lifecycle: boolean,
  ): Promise<VerificationConclusion> {
    requireKey(idempotencyKey, lifecycle ? "verifyExecution" : "verifyTarget");
    requireScope(input);
    requireCriteriaRefs(input.criteria);

    const target: VerificationTarget = lifecycle
      ? { kind: "execution-output", ref: input.executionId }
      : (input as VerifyTargetInput).target;

    const fingerprint = fingerprintOf([
      lifecycle ? "verification.verifyExecution" : "verification.verifyTarget",
      input.applicationId,
      input.executionId,
      input.actor.actorId,
      target,
      input.criteria,
      input.evidence,
    ]);

    // Idempotent replay.
    const existing = await store.findEvaluationByKey(input.applicationId, idempotencyKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          details: { evaluationId: existing.id },
        });
      }
      if (existing.status === "concluded" && existing.conclusion !== null) {
        const results = await store.listResults(input.applicationId, input.executionId);
        return {
          executionId: existing.executionId,
          applicationId: existing.applicationId,
          tenantId: existing.tenantId,
          evaluationId: existing.id,
          criteriaMet: existing.conclusion.criteriaMet,
          requiredUnmet: existing.conclusion
            .requiredUnmet as VerificationConclusion["requiredUnmet"],
          results: results.filter((result) => result.provenance.evaluationId === existing.id),
          ...(existing.conclusion.replanningDecision === undefined
            ? {}
            : {
                replanningDecision: existing.conclusion
                  .replanningDecision as VerificationConclusion["replanningDecision"],
              }),
          completed: existing.conclusion.completed,
          replayed: true,
        };
      }
      if (existing.status === "denied") {
        throw policyDenied(existing.denialReason ?? "verification denied by the effective policy");
      }
      // status "evaluating": a previous attempt crashed mid-flight —
      // continue the SAME logical evaluation (re-run; results are
      // append-only evidence, the conclusion counts the latest).
    }

    // Identity/tenant + execution binding.
    const execution = await bindExecution(
      input.applicationId,
      input.executionId,
      input.actor.tenantId,
    );

    // POLICY admission (REQUIRED seam — action "evaluate").
    const admissionDecision = await admission.admit({
      action: "evaluate",
      tenantId: input.actor.tenantId,
      applicationId: input.applicationId,
      executionId: input.executionId,
    });
    if (!admissionDecision.allowed) {
      // Durable denial evidence (the journal row) + typed failure.
      const evaluationId = generateId();
      await store.claimEvaluation({
        id: evaluationId,
        applicationId: input.applicationId,
        tenantId: input.actor.tenantId,
        executionId: input.executionId,
        evaluationKey: idempotencyKey,
        requestFingerprint: fingerprint,
        targetKind: target.kind,
        targetRef: target.ref,
        targetRevision: target.revision ?? null,
        criteria: input.criteria,
        policyEvidence: null,
        now: iso(),
      });
      await store.denyEvaluation({
        applicationId: input.applicationId,
        evaluationId,
        reason: `verification denied by the effective policy: ${admissionDecision.reason}`,
        now: iso(),
      });
      throw policyDenied(
        `verification denied by the effective policy: ${admissionDecision.reason}`,
      );
    }

    // Execution-lifecycle mode: the verification step of the execution
    // (RUNNING → VERIFYING through the executions authority; an execution
    // already VERIFYING re-enters evaluation — replan/re-verify loops).
    if (lifecycle) {
      if (execution.status === "RUNNING") {
        await transitions.verify(
          {
            executionId: input.executionId,
            applicationId: input.applicationId,
            actor: input.actor,
            ...(input.cause === undefined ? {} : { reason: input.cause }),
          },
          `${idempotencyKey}:verify-edge`,
        );
      } else if (execution.status !== "VERIFYING") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `execution-output verification requires the execution to be RUNNING or VERIFYING (found ${execution.status})`,
          details: { executionId: input.executionId, status: execution.status },
        });
      }
    }

    // Durable evaluation intent (journal claim) BEFORE any evaluation.
    // Concurrent duplicates converge on the durable row (unique-index
    // arbitration): a claim that finds an existing row with a DIFFERENT
    // fingerprint fails IDEMPOTENCY_KEY_REUSED; the same fingerprint
    // continues the SAME logical evaluation.
    const claimed = await store.claimEvaluation({
      id: existing?.id ?? generateId(),
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      executionId: input.executionId,
      evaluationKey: idempotencyKey,
      requestFingerprint: fingerprint,
      targetKind: target.kind,
      targetRef: target.ref,
      targetRevision: target.revision ?? null,
      criteria: input.criteria,
      policyEvidence: admissionDecision.evidence ?? null,
      now: iso(),
    });
    if (claimed.existing && claimed.record.requestFingerprint !== fingerprint) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "idempotency key was already used with a different request fingerprint",
        details: { evaluationId: claimed.record.id },
      });
    }
    const evaluationId = claimed.record.id;
    const ledgerOutcome = await ledger.recordStepEvent(
      {
        applicationId: input.applicationId,
        executionId: input.executionId,
        actor: { actorId: input.actor.actorId, tenantId: input.actor.tenantId },
        command: "verification-requested",
        cause: input.cause ?? "verification-requested",
        reference: {
          evaluationId,
          target: { kind: target.kind, ref: target.ref },
          criteria: input.criteria,
        },
        payload: {
          lifecycle,
          criteriaCount: input.criteria.length,
          evidenceRefs: input.evidence.evidenceRefs,
        },
      },
      `${evaluationId}:requested`,
    );
    await store.bindLedgerSequence({
      applicationId: input.applicationId,
      evaluationId,
      ledgerRequestedSequence: ledgerOutcome.sequence,
    });

    // Criteria + target resolution (fail closed).
    const criteria = await resolveCriteria(input.applicationId, input.criteria);
    await resolveTarget({
      tenantId: input.actor.tenantId,
      applicationId: input.applicationId,
      executionId: input.executionId,
      target,
    });

    // The evaluation itself (deterministic-first).
    const results = await runEvaluation({
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      executionId: input.executionId,
      actorId: input.actor.actorId,
      evaluationId,
      target,
      criteria,
      evidence: {
        target: target as EvidenceBundle["target"],
        facts: input.evidence.facts,
        evidenceRefs: input.evidence.evidenceRefs,
      },
      policyEvidence: admissionDecision.evidence ?? undefined,
      ...(input.cause === undefined ? {} : { cause: input.cause }),
      priorHumanResults: [],
    });

    // Conclusion + completion/replan boundary.
    return concludeEvaluation({
      applicationId: input.applicationId,
      tenantId: input.actor.tenantId,
      executionId: input.executionId,
      actor: input.actor,
      evaluationId,
      target,
      criteria,
      results,
      lifecycle,
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    });
  }

  async function singleFlight<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existingFlight = inFlight.get(key);
    if (existingFlight !== undefined) {
      return existingFlight as Promise<T>;
    }
    const flight = operation().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, flight);
    return flight;
  }

  // -------------------------------------------------------------------------
  // Public operations.
  // -------------------------------------------------------------------------

  const service: VerificationService = {
    async declareCriteria(input) {
      const validation = validateCriteriaDeclaration(input.criteria);
      if (!validation.ok) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `criteria declaration rejected: ${validation.issues.join("; ")}`,
          details: { issues: validation.issues },
        });
      }
      if (!isUuid(input.applicationId) || !isUuid(input.tenantId)) {
        throw policyDenied("criteria declaration requires a valid application/tenant scope");
      }
      const outcome = await store.declareCriteria(input);
      return { converged: outcome.converged };
    },

    verifyExecution(input, idempotencyKey) {
      return singleFlight(`${input.applicationId}|verifyExecution|${idempotencyKey}`, () =>
        verifyFlow(input, idempotencyKey, true),
      ) as Promise<VerificationConclusion>;
    },

    verifyTarget(input, idempotencyKey) {
      return singleFlight(`${input.applicationId}|verifyTarget|${idempotencyKey}`, () =>
        verifyFlow(input, idempotencyKey, false),
      ) as Promise<VerificationConclusion>;
    },

    async requestHumanEvaluation(input, idempotencyKey) {
      requireKey(idempotencyKey, "requestHumanEvaluation");
      requireScope(input);
      if (typeof input.criterionId !== "string" || input.criterionId.length === 0) {
        throw policyDenied("human evaluation requires a criterionId");
      }
      if (typeof input.criteriaVersion !== "number" || input.criteriaVersion < 1) {
        throw policyDenied("human evaluation requires a positive criteriaVersion");
      }
      if (typeof input.question !== "string" || input.question.length === 0) {
        throw policyDenied("human evaluation requires a non-empty question");
      }

      const fingerprint = fingerprintOf([
        "verification.requestHumanEvaluation",
        input.applicationId,
        input.executionId,
        input.actor.actorId,
        input.target,
        input.criterionId,
        input.criteriaVersion,
        input.question,
        input.evidenceRefs ?? [],
      ]);

      const existing = await store.findHumanRequestByKey(input.applicationId, idempotencyKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { requestId: existing.id },
          });
        }
        return { request: existing, replayed: true };
      }

      await bindExecution(input.applicationId, input.executionId, input.actor.tenantId);

      // POLICY admission (REQUIRED seam — the human-escalation gate).
      const decision = await admission.admit({
        action: "human-evaluation",
        tenantId: input.actor.tenantId,
        applicationId: input.applicationId,
        executionId: input.executionId,
      });
      if (!decision.allowed) {
        throw policyDenied(`human evaluation denied by the effective policy: ${decision.reason}`);
      }

      const request: HumanEvaluationRequestRecord = {
        id: generateId(),
        applicationId: input.applicationId,
        tenantId: input.actor.tenantId,
        executionId: input.executionId,
        requestKey: idempotencyKey,
        requestFingerprint: fingerprint,
        target: input.target as HumanEvaluationRequestRecord["target"],
        criterionId: input.criterionId,
        criteriaVersion: input.criteriaVersion,
        question: input.question,
        evidence: input.evidenceRefs ?? [],
        requestedBy: input.actor.actorId,
        ...(decision.evidence === undefined ? {} : { policyEvidence: decision.evidence }),
        requestedAt: iso(),
      };
      const inserted = await store.insertHumanRequest({ request });
      await ledger.recordStepEvent(
        {
          applicationId: input.applicationId,
          executionId: input.executionId,
          actor: { actorId: input.actor.actorId, tenantId: input.actor.tenantId },
          command: "human-evaluation-requested",
          cause: input.cause ?? "explicit human evaluation request",
          reference: { humanRequestId: inserted.id, criterionId: inserted.criterionId },
          payload: { question: inserted.question, evidenceCount: inserted.evidence.length },
        },
        `${inserted.id}:requested`,
      );
      return { request: inserted, replayed: false };
    },

    async submitHumanDecision(input, idempotencyKey) {
      requireKey(idempotencyKey, "submitHumanDecision");
      const issues = validateHumanDecision(input);
      if (issues.length > 0) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `human decision rejected: ${issues.join("; ")}`,
          details: { issues },
        });
      }

      const request = await store.findHumanRequest(input.applicationId, input.requestId);
      if (request === null) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message:
            "human evaluation request not found in this application (decisions exist only for admitted requests)",
          details: { requestId: input.requestId },
        });
      }
      if (request.tenantId !== input.tenantId || request.executionId !== input.executionId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "human evaluation request belongs to a different tenant/execution scope",
          details: { requestId: input.requestId },
        });
      }
      if (request.answeredByResultId !== undefined) {
        // Exactly-once: an identical re-submit replays the durable result;
        // a DIFFERENT decision for the same request fails closed.
        const answered = await store.getResult(input.applicationId, request.answeredByResultId);
        if (
          answered !== null &&
          answered.status === input.decision &&
          request.answeredBy === input.decidedBy
        ) {
          return { request, result: answered, replayed: true };
        }
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "this human evaluation request is already answered by a different decision (one decision per request)",
          details: { requestId: input.requestId, answeredByResultId: request.answeredByResultId },
        });
      }

      await bindExecution(input.applicationId, input.executionId, input.tenantId);

      // The decision is ITSELF a governed evaluation: claim its durable
      // journal row (idempotent by the request's decision key) so the
      // result's provenance binds to real evaluation evidence (M24).
      const decisionClaim = await store.claimEvaluation({
        id: generateId(),
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        executionId: input.executionId,
        evaluationKey: `${request.id}:decision`,
        requestFingerprint: fingerprintOf([
          "verification.submitHumanDecision",
          input.requestId,
          input.decidedBy,
          input.decision,
        ]),
        targetKind: request.target.kind,
        targetRef: request.target.ref,
        targetRevision: request.target.revision ?? null,
        criteria: [{ criterionId: request.criterionId, version: request.criteriaVersion }],
        policyEvidence: null,
        now: iso(),
      });
      const evaluationId = decisionClaim.record.id;

      // The attributable, provenance-preserving human result.
      const result: VerificationResultRecord = {
        id: generateId(),
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        executionId: input.executionId,
        target: request.target,
        criterionId: request.criterionId,
        criteriaVersion: request.criteriaVersion,
        evaluator: { kind: "human", id: "human-mediated", version: "1" },
        status: input.decision,
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        observations: [`human decision by ${input.decidedBy}: ${input.rationale}`],
        evidence: [
          `human-request:${request.id}`,
          ...(input.evidenceRefs ?? []).map((ref) => `evidence:${ref}`),
        ],
        ...(request.policyEvidence === undefined
          ? {}
          : {
              policyEvidence:
                request.policyEvidence as unknown as VerificationResultRecord["policyEvidence"],
            }),
        provenance: {
          evaluationId,
          actorId: input.decidedBy,
          humanRequestId: request.id,
        },
        recordedBy: `human:${input.decidedBy}`,
        recordedAt: iso(),
      };
      const validation = validateResult(result);
      if (!validation.ok) {
        throw new PlatformError({
          code: "VERIFICATION_FAILED",
          message: `human decision result is not recordable: ${validation.issues.join("; ")}`,
          details: { issues: validation.issues },
        });
      }
      const inserted = await store.insertResult({ result });
      const answer = await store.answerHumanRequest({
        applicationId: input.applicationId,
        requestId: request.id,
        resultId: inserted.id,
        decidedBy: input.decidedBy,
        now: iso(),
      });
      if (answer.status === "missing") {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "human evaluation request disappeared before the answer could bind",
          details: { requestId: request.id },
        });
      }
      if (answer.status === "conflict") {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message:
            "this human evaluation request was answered concurrently by a different decision (fail closed)",
          details: { requestId: request.id },
        });
      }
      // Conclude the decision's journal row (idempotent: a converged row
      // re-concludes on the same outcome).
      await store.completeEvaluation({
        applicationId: input.applicationId,
        evaluationId,
        conclusion: {
          criteriaMet: input.decision === "PASS",
          requiredUnmet:
            input.decision === "PASS"
              ? []
              : [
                  {
                    criterionId: request.criterionId,
                    criteriaVersion: request.criteriaVersion,
                    status: input.decision === "FAIL" ? "FAIL" : "INCONCLUSIVE",
                    reason: `human decision: ${input.rationale}`,
                  },
                ],
          completed: false,
        },
        now: iso(),
      });
      await ledger.recordStepEvent(
        {
          applicationId: input.applicationId,
          executionId: input.executionId,
          actor: { actorId: input.decidedBy, tenantId: input.tenantId },
          command: "human-decision-recorded",
          cause: "human evaluation decision",
          reference: {
            humanRequestId: request.id,
            verificationResultId: inserted.id,
            criterionId: inserted.criterionId,
            decidedBy: input.decidedBy,
          },
          payload: {
            decision: inserted.status,
            rationale: input.rationale,
            criteriaVersion: inserted.criteriaVersion,
          },
        },
        `${request.id}:decision:${inserted.id}`,
      );
      return { request: answer.request, result: inserted, replayed: false };
    },

    async compareCandidates(input, idempotencyKey) {
      requireKey(idempotencyKey, "compareCandidates");
      requireScope(input);
      const issues = [
        ...validateComparison({ ...input, tenantId: input.actor.tenantId }),
        ...validatePlannerAuthorization(input.plannerAuthorization),
      ];
      if (issues.length > 0) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `candidate comparison rejected: ${issues.join("; ")}`,
          details: { issues },
        });
      }

      const fingerprint = fingerprintOf([
        "verification.compareCandidates",
        input.applicationId,
        input.executionId,
        input.actor.actorId,
        input.criterionId,
        input.criteriaVersion,
        input.candidates,
        input.plannerAuthorization,
      ]);

      const existing = await store.findComparisonByKey(input.applicationId, idempotencyKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { comparisonId: existing.id },
          });
        }
        return { comparison: existing, replayed: true };
      }

      await bindExecution(input.applicationId, input.executionId, input.actor.tenantId);

      // POLICY admission (REQUIRED seam).
      const decision = await admission.admit({
        action: "compare-candidates",
        tenantId: input.actor.tenantId,
        applicationId: input.applicationId,
        executionId: input.executionId,
      });
      if (!decision.allowed) {
        throw policyDenied(
          `candidate comparison denied by the effective policy: ${decision.reason}`,
        );
      }

      // Declared criteria only.
      const criteria = await store.findCriteria(
        input.applicationId,
        input.criterionId,
        input.criteriaVersion,
      );
      if (criteria === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `criterion ${input.criterionId}@${input.criteriaVersion} is not declared`,
          details: { criterionId: input.criterionId, version: input.criteriaVersion },
        });
      }

      const evaluator = selectEvaluator(evaluators, criteria.kind);
      const perCandidate: {
        candidateId: string;
        status: "PASS" | "FAIL" | "INCONCLUSIVE";
        observations: readonly string[];
      }[] = [];
      const rationale: string[] = [];

      for (const candidate of input.candidates) {
        if (criteria.kind === "human-judged") {
          // Human-judged comparisons require the mediated human path — the
          // comparison itself records per-candidate INCONCLUSIVE and the
          // request path decides (no silent evaluator substitution).
          perCandidate.push({
            candidateId: candidate.candidateId,
            status: "INCONCLUSIVE",
            observations: ["human-judged comparison criterion — mediated decision required"],
          });
          rationale.push(`candidate ${candidate.candidateId}: pending human judgment`);
          continue;
        }
        if (evaluator === null) {
          perCandidate.push({
            candidateId: candidate.candidateId,
            status: "INCONCLUSIVE",
            observations: [`no registered evaluator establishes criterion kind "${criteria.kind}"`],
          });
          rationale.push(`candidate ${candidate.candidateId}: no evaluator`);
          continue;
        }
        const evaluatorDecision = await admission.admit({
          action: criteria.kind === "model-judged" ? "model-evaluation" : "evaluate",
          tenantId: input.actor.tenantId,
          applicationId: input.applicationId,
          executionId: input.executionId,
          evaluator: evaluator.identity,
          provider: evaluator.identity.kind === "model" ? evaluator.identity.id : undefined,
        });
        if (!evaluatorDecision.allowed) {
          throw policyDenied(
            `comparison evaluator denied by the effective policy: ${evaluatorDecision.reason}`,
          );
        }
        const outcome = await evaluator.evaluate(
          {
            target: { kind: "candidate", ref: candidate.candidateId },
            facts: candidate.facts,
            evidenceRefs: candidate.evidenceRefs,
          },
          {
            criterionId: criteria.criterionId,
            version: criteria.version,
            kind: criteria.kind,
            definition: criteria.definition,
          },
          {
            applicationId: input.applicationId,
            tenantId: input.actor.tenantId,
            executionId: input.executionId,
            actorId: input.actor.actorId,
          },
        );
        perCandidate.push({
          candidateId: candidate.candidateId,
          status: outcome.status,
          observations: outcome.observations,
        });
        rationale.push(
          `candidate ${candidate.candidateId}: ${outcome.status}${
            outcome.observations.length > 0 ? ` (${outcome.observations.join("; ")})` : ""
          }`,
        );
      }

      // Explicit selection discipline: a winner exists ONLY when exactly
      // one candidate decisively satisfies the criteria; multiple or zero
      // satisfactions are honest INCONCLUSIVE/FAIL — never a forced pick.
      const passing = perCandidate.filter((entry) => entry.status === "PASS");
      const anyInconclusive = perCandidate.some((entry) => entry.status === "INCONCLUSIVE");
      let status: CandidateComparisonRecord["status"];
      let winner: string | undefined;
      if (passing.length === 1) {
        status = "PASS";
        winner = passing[0]?.candidateId;
        rationale.push(`criteria decisively select candidate ${winner}`);
      } else if (passing.length === 0 && !anyInconclusive) {
        status = "FAIL";
        rationale.push("no candidate satisfies the criteria");
      } else {
        status = "INCONCLUSIVE";
        rationale.push(
          passing.length > 1
            ? "multiple candidates satisfy the criteria — the criteria do not discriminate (no forced winner)"
            : "uncertainty unresolved — no forced winner",
        );
      }

      const comparison: CandidateComparisonRecord = {
        id: generateId(),
        applicationId: input.applicationId,
        tenantId: input.actor.tenantId,
        executionId: input.executionId,
        comparisonKey: idempotencyKey,
        requestFingerprint: fingerprint,
        criterionId: criteria.criterionId,
        criteriaVersion: criteria.version,
        candidates: input.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          evidenceRefs: candidate.evidenceRefs,
          facts: candidate.facts,
        })),
        status,
        ...(winner === undefined ? {} : { winner }),
        perCandidate,
        rationale,
        evaluator:
          evaluator === null
            ? { kind: "deterministic", id: "none", version: "0" }
            : evaluator.identity,
        plannerAuthorization: input.plannerAuthorization,
        ...(decision.evidence === undefined ? {} : { policyEvidence: decision.evidence }),
        comparedAt: iso(),
      };

      const inserted = await store.insertComparison({ comparison });
      await ledger.recordStepEvent(
        {
          applicationId: input.applicationId,
          executionId: input.executionId,
          actor: { actorId: input.actor.actorId, tenantId: input.actor.tenantId },
          command: "comparison-recorded",
          cause: input.cause ?? "candidate comparison",
          reference: {
            comparisonId: inserted.id,
            criterionId: inserted.criterionId,
            winner: inserted.winner ?? null,
            plannerDecisionRef: input.plannerAuthorization.decisionRef,
          },
          payload: {
            status: inserted.status,
            candidates: inserted.candidates.map((candidate) => candidate.candidateId),
            perCandidate: inserted.perCandidate,
          },
        },
        `${inserted.id}:recorded`,
      );
      return { comparison: inserted, replayed: false };
    },

    listResults(applicationId, executionId) {
      return store.listResults(applicationId, executionId);
    },

    getEvaluation(applicationId, evaluationKey) {
      return store.findEvaluationByKey(applicationId, evaluationKey);
    },
  };

  return service;
}
