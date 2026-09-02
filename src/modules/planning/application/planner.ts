/**
 * The deterministic-first planner service (planning module application;
 * WORK-009 / ADR-0007, ADR-0011, `spec/planning-contract.md`).
 *
 * THE PIPELINE ORDER IS THE PROTECTION (task -> policy -> capabilities ->
 * deterministic sufficiency -> candidates -> provider/model selection ->
 * verification):
 *
 *  1. `deriveTaskProfile` — structured profile, pure derivation (INT-001);
 *  2. `policyInputs.effective` — the policy authority's resolved
 *     restrictions (captured as decision evidence; a deny fails closed);
 *  3. `capabilityAuthority.resolve` — capability resolution BEFORE any
 *     route exists (INT-002);
 *  4. `evaluateDeterministicSufficiency` — the explicit ADR-0007 decision;
 *  5. candidate composition — the route explorer is consulted ONLY when
 *     the sufficiency decision is not `sufficient` (zero-model tasks
 *     never touch provider data — the spy-provable ordering boundary);
 *  6. `filterAdmissibility` + `selectStrategy` — policy as hard
 *     constraints; the deterministic-first preference when sufficient;
 *  7. `emitSubgraphEvidence` — DTR-001/DTR-004 evidence;
 *  8. `validatePlanningDecision` + `sink.record` — the executions ledger
 *     owns durable append, idempotency and concurrency arbitration.
 *
 * The planner introduces NO state machine of its own: execution status
 * transitions (AUTHORIZED -> PLANNING -> QUEUED, VERIFYING -> REPLANNING)
 * stay owned by the executions module; the planner only records
 * append-only decisions through the ledger while the execution is in a
 * planning phase.
 */

import { PlatformError } from "../../../shared/errors";
import type { CapabilityResolution, TaskCapabilityProfile } from "../../capabilities/public";
import type { PolicyRequestContext } from "../../policies/public";
import type {
  CandidateStrategy,
  CompositionConsultation,
  ConsultedLearnedPolicy,
  DeterministicizationConsultation,
  DeterministicSufficiencyDecision,
  ExecutionPlan,
  LearnedPolicyConsultation,
  LearningConsultation,
  OpportunityConsultation,
  PlanningDecisionRecord,
  RouteRationale,
  TaskConstraintInput,
  TaskProfile,
} from "../domain";
import {
  buildCompositionConsultation,
  buildDeterministicizationConsultation,
  buildLearnedPolicyConsultation,
  buildLearningConsultation,
  buildOpportunityConsultation,
  buildPlan,
  canonicalJson,
  decisionRecordDigest,
  deriveTaskProfile,
  emitSubgraphEvidence,
  evaluateDeterministicSufficiency,
  filterAdmissibility,
  learnedOrderingSubjects,
  PLANNER_VERSION,
  selectStrategy,
  validatePlanningDecision,
} from "../domain";
import type { SubstrateSelection } from "../domain/substrate-selection";
import { validateSubstrateSelection } from "../domain/substrate-selection";
import { isWorkloadClass } from "../domain/workload-class";
import type { PlanningCapabilityAuthority } from "../ports/capability-authority";
import type { CompositionRecommendations } from "../ports/composition-recommendations";
import type { DeterministicCatalogEntry } from "../ports/deterministic-catalog";
import type { DeterministicizationSignals } from "../ports/deterministicization-signals";
import type { DigestPort } from "../ports/digest";
import type { LearnedPolicySource } from "../ports/learned-policy";
import type { LearningSignals } from "../ports/learning-signals";
import type { ModelRouteCandidate, ModelRouteExplorer } from "../ports/model-routes";
import type { OpportunitySignals } from "../ports/opportunity-signals";
import type { PlanningDecisionSink } from "../ports/planning-sink";
import type { PlanningPolicyInputs } from "../ports/policy-inputs";
import type { SubstrateCatalog } from "../ports/substrate-catalog";

export interface PlannerServiceDeps {
  readonly capabilityAuthority: PlanningCapabilityAuthority;
  readonly policyInputs: PlanningPolicyInputs;
  readonly routeExplorer: ModelRouteExplorer;
  readonly deterministicCatalog: {
    list(): Promise<readonly DeterministicCatalogEntry[]>;
  };
  readonly sink: PlanningDecisionSink;
  readonly digest: DigestPort;
  readonly generateId: () => string;
  readonly now: () => Date;
  /**
   * OPTIONAL learning READ seam (WORK-014 / INT-006): when wired, the
   * planner consults versioned learning signals AFTER the governed
   * selection and records the consultation as decision EVIDENCE — the
   * live selection is never changed by it (M1/M8: learning is
   * consultable, never commanding). Unwired ⇒ zero learning
   * interaction (planning works without learning history).
   */
  readonly learningSignals?: LearningSignals;
  /**
   * OPTIONAL composition-recommendation READ seam (WORK-017): when
   * wired, the planner consults the ACTIVE recommendation set AFTER
   * the governed selection and records the consultation as decision
   * EVIDENCE — the live selection is never changed by it (the
   * recommendation is advisory: RECOMMENDATION ≠ AUTHORIZATION ≠
   * planning authority — M1/M18). The consultation re-checks every
   * recommendation's tools against the CURRENT effective policy
   * (M5: a forbidden tool can never become a preferred recommendation
   * regardless of its learning score). Unwired ⇒ zero composition
   * interaction (planning works without recommendation history).
   */
  readonly compositionRecommendations?: CompositionRecommendations;
  /**
   * OPTIONAL learned-planning-policy READ seam (WORK-020 / LRN-002):
   * when wired, the planner consults the ACTIVE learned-policy
   * publication AFTER every hard authority has spoken (policy inputs,
   * capability resolution, deterministic sufficiency, candidate
   * composition and the HARD policy admissibility filter) and BEFORE
   * the cascade selection — because a PUBLISHED learned policy (mode
   * 'promoted' only) may refine the ORDERING among already-admissible
   * candidates. A canary publication (or no publication at all)
   * records its preference as divergence evidence and NEVER changes
   * the live selection. The consulted record is validated and
   * restriction-vocabulary-scanned at the adapter seam; the planner
   * re-checks every ranked subject against the CURRENT effective
   * policy at consultation time (forbidden subjects are dropped and
   * recorded). Unwired ⇒ zero learned-policy interaction.
   */
  readonly learnedPolicy?: LearnedPolicySource;
  /**
   * OPTIONAL codebase-opportunity READ seam (WORK-022 / DTR-005): when
   * wired, the planner consults the application's advisory
   * opportunity findings AFTER the governed selection and records the
   * consultation as decision EVIDENCE — the live selection is never
   * changed by it (the finding is advisory: RECOMMENDATION ≠ PLANNER
   * DECISION ≠ AUTHORIZATION — M17). The consultation validates every
   * finding's version/provenance basis at the seam (an unversioned or
   * unprovenanced finding fails closed and never enters a decision
   * record). Unwired ⇒ zero opportunity interaction (planning works
   * without codebase-analysis history).
   */
  readonly opportunitySignals?: OpportunitySignals;
  /**
   * OPTIONAL deterministicization READ seam (WORK-021 / DTR-001..004):
   * when wired, the planner consults the application's
   * deterministicization lifecycle candidates AFTER the governed
   * selection and records the consultation as decision EVIDENCE — the
   * live selection is never changed by it (a promoted replacement is
   * an input to FUTURE plan composition, never a live-route rewrite —
   * DTR-003's "without changing execution identity"; M-canary:
   * shadow/canary candidates are divergence evidence only). The
   * consultation validates every candidate's provenance/contract
   * anchors at the seam (an unprovenanced candidate fails closed and
   * never enters a decision record). Unwired ⇒ zero
   * deterministicization interaction (planning works without
   * deterministicization history).
   */
  readonly deterministicizationSignals?: DeterministicizationSignals;
  /**
   * OPTIONAL substrate catalog READ seam (WORK-031 / CSX-003): when
   * wired AND the request declares a workload class, the planner
   * consults the provider-neutral substrate catalog AFTER the governed
   * selection and records the substrate selection as decision
   * EVIDENCE with the CSX-003 ordering proof. Deterministic-first is
   * applied BEFORE the consultation: a deterministic-sufficient
   * strategy records "no-substrate-required" and never consults the
   * catalog. Unwired ⇒ zero substrate interaction (planning works
   * without a substrate catalog — CSX-004's extensibility posture).
   */
  readonly substrateCatalog?: SubstrateCatalog;
  /**
   * Discrimination hook (WORK-005 validation-hook precedent): the
   * deterministic-sufficiency evaluator is injectable so mutation records
   * can REMOVE the deterministic-first protection and observe the
   * violation (an always-insufficient hook makes the planner behave like
   * an always-generative router). Production never overrides it — the
   * default IS `evaluateDeterministicSufficiency`.
   */
  readonly sufficiency?: (input: {
    readonly profile: TaskProfile;
    readonly resolution: CapabilityResolution;
    readonly catalog: readonly DeterministicCatalogEntry[];
  }) => DeterministicSufficiencyDecision;
}

export interface PlanExecutionInput {
  readonly applicationId: string;
  readonly executionId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly constraints?: TaskConstraintInput;
  readonly userId?: string;
  /** Prior decision this replan replaces (verification-triggered). */
  readonly replanOf?: string;
}

export interface PlanningOutcome {
  readonly decision: PlanningDecisionRecord;
  readonly selectedPlan: ExecutionPlan;
  readonly replayed: boolean;
  readonly sequence: number;
}

export interface PlannerService {
  planExecution(input: PlanExecutionInput, idempotencyKey: string): Promise<PlanningOutcome>;
}

/**
 * The isolation ladder rank (the policies ladder order, mirrored by
 * value for the substrate admissibility filter — the capabilities
 * module's substrate vocabulary mirrors the same ladder).
 */
const ISOLATION_LADDER: readonly string[] = [
  "none",
  "process",
  "container",
  "microvm",
  "vm",
  "customer-runner",
];
function isolationRank(isolation: string): number {
  const rank = ISOLATION_LADDER.indexOf(isolation);
  return rank === -1 ? 0 : rank;
}

export function createPlannerService(deps: PlannerServiceDeps): PlannerService {
  const digestValue = (value: unknown): string => deps.digest.sha256Hex(canonicalJson(value));
  const sufficiencyEvaluator =
    deps.sufficiency ??
    ((input: {
      readonly profile: TaskProfile;
      readonly resolution: CapabilityResolution;
      readonly catalog: readonly DeterministicCatalogEntry[];
    }) => evaluateDeterministicSufficiency(input));

  const iso = (): string => deps.now().toISOString();

  return {
    async planExecution(input, idempotencyKey) {
      // 1. Structured task profile (pure, fail-closed typed).
      const profile = deriveTaskProfile(
        {
          task: input.task,
          ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
        },
        digestValue,
      );
      const context: PolicyRequestContext = {
        tenantId: input.tenantId,
        applicationId: input.applicationId,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
      };

      // 2. Policy inputs FIRST (planning-contract order) — resolved by the
      //    policy authority, never re-implemented here.
      const policy = await deps.policyInputs.effective(context);
      if (policy.outcome === "deny") {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "policy resolution denied this planning context",
          details: { denial: policy.denial ?? {} },
        });
      }
      const effective = policy.effective ?? {};

      // 3. Capability resolution BEFORE any provider/model selection.
      const capabilityProfile: TaskCapabilityProfile = {
        requirements: profile.capabilityRequirements,
      };
      const resolution = await deps.capabilityAuthority.resolve(capabilityProfile);

      // 4. Deterministic sufficiency — the explicit ADR-0007 decision.
      const catalog = await deps.deterministicCatalog.list();
      const sufficiency = sufficiencyEvaluator({
        profile,
        resolution,
        catalog,
      });

      // 5. Candidate composition. The route explorer is consulted ONLY
      //    when the sufficiency decision is not `sufficient`: a task a
      //    deterministic capability satisfies never reaches provider
      //    selection (no hidden AI calls, no provider-first ordering).
      let routes: readonly ModelRouteCandidate[] = [];
      if (sufficiency.outcome !== "sufficient") {
        const modelRequirementIds = profile.capabilityRequirements
          .filter((requirement) => requirement.kind === "model")
          .map((requirement) => requirement.id);
        if (modelRequirementIds.length > 0) {
          routes = await deps.routeExplorer.explore(modelRequirementIds);
        }
      }

      const candidates = composeCandidates({
        profile,
        sufficiency,
        catalog,
        routes,
        digest: digestValue,
      });

      // 6. Policy as HARD constraints, then deterministic-first selection.
      const admissibleCandidates = candidates.map((candidate) =>
        filterAdmissibility(candidate, effective),
      );

      // 6.2 The learning-free governed selection (the audit anchor):
      //     computed WITHOUT any learned-policy ordering — the
      //     WORK-020 consultation below may refine the cascade
      //     ordering, and this anchor records exactly what the
      //     refinement changed (appliedToSelection is honest by
      //     construction: it compares against THIS selection).
      const governedSelection = selectStrategy(
        admissibleCandidates,
        sufficiency,
        profile.qualityTarget,
      );

      // 6.3 OPTIONAL learned-policy consultation (WORK-020 / LRN-002)
      //     — READ ONLY, AFTER every hard authority has spoken: the
      //     policy inputs (step 2), the capability resolution (step 3),
      //     the deterministic-sufficiency decision (step 4), the
      //     candidate composition (step 5) and the HARD policy
      //     admissibility filter (step 6) all PRECEDE the consultation,
      //     so a learned preference can never widen, bypass or override
      //     a prohibition, never re-classify sufficiency and never
      //     revive an inadmissible candidate — the consultation output
      //     is structurally an ORDERING KEY over the already-admissible
      //     pool. ONLY a 'promoted' publication produces an ordering
      //     input: a 'canary' publication (or none) records its
      //     preference as divergence evidence and never orders the
      //     cascade. Every ranked subject is re-checked against the
      //     CURRENT effective policy at consultation time; forbidden
      //     subjects are dropped from the ordering and recorded as
      //     rejected. A consultation failure fails the planning request
      //     closed — a malformed/unversioned record NEVER reaches the
      //     selection or a decision record.
      let learnedOrdering: readonly string[] | undefined;
      let consultedPolicy: ConsultedLearnedPolicy | undefined;
      if (deps.learnedPolicy !== undefined) {
        const view = await deps.learnedPolicy.consult({
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          taskClass: profile.kind,
        });
        if (view !== null) {
          consultedPolicy = view;
          if (view.publicationMode === "promoted") {
            const preference = view.preferences.find(
              (candidate) => candidate.taskClass === profile.kind,
            );
            if (preference !== undefined) {
              const ordering = learnedOrderingSubjects(preference, effective);
              if (ordering.length > 0) {
                learnedOrdering = ordering;
              }
            }
          }
        }
      }

      const selection = selectStrategy(
        admissibleCandidates,
        sufficiency,
        profile.qualityTarget,
        learnedOrdering,
      );
      if (selection.kind === "none") {
        throw new PlatformError({
          code: "NO_ELIGIBLE_ROUTE",
          message:
            "no admissible execution strategy satisfies the task under the effective policy (deterministic sufficiency was not achieved and/or every generative route is policy-inadmissible)",
          details: {
            sufficiency: sufficiency.outcome,
            candidates: admissibleCandidates.map((candidate) => ({
              strategyId: candidate.strategyId,
              admissible: candidate.admissible,
              inadmissibleReason: candidate.inadmissibleReason ?? null,
            })),
          },
        });
      }
      const selected = selection.selected;

      // 6.4 Build the learned-policy consultation capture (WORK-020) —
      //     the recorded evidence: the consulted policy with its full
      //     anchors, the policy re-check verdicts (rejected subjects,
      //     unmatched subjects — a learned preference cannot introduce
      //     anything), the learned preference among ADMISSIBLE
      //     candidates, and the honest appliedToSelection verdict
      //     (true ONLY when a 'promoted' ordering refined the live
      //     selection away from the governed default; canary/shadow
      //     never set it).
      let learnedPolicyConsultation: LearnedPolicyConsultation | undefined;
      if (consultedPolicy !== undefined && governedSelection.kind === "selected") {
        learnedPolicyConsultation = buildLearnedPolicyConsultation({
          candidates: admissibleCandidates,
          consultedPolicy,
          taskClass: profile.kind,
          policy: effective,
          governedStrategyId: governedSelection.selected.strategyId,
          selectedStrategyId: selected.strategyId,
          appliedToSelection: governedSelection.selected.strategyId !== selected.strategyId,
          consultedAt: iso(),
        });
      }

      // 7. Subgraph-level evidence (DTR-001/DTR-004).
      const routeCosts: Record<string, { costMicroUsd: string; quality: number }> = {};
      for (const route of routes) {
        routeCosts[`${route.provider}\u0000${route.model}`] = {
          costMicroUsd: route.expectedCostMicroUsd,
          quality: route.expectedQuality,
        };
      }
      const subgraphEvidence = emitSubgraphEvidence(selected.plan, catalog, routeCosts);

      // 7.5 OPTIONAL learning consultation (WORK-014 / INT-006) — READ
      //     ONLY, AFTER the governed selection: the consultation is
      //     captured as decision evidence; it cannot change `selected`
      //     (already computed above), cannot revive an inadmissible
      //     candidate (the preference considers ADMISSIBLE candidates
      //     only) and cannot bypass deterministic-first (M1/M8). A
      //     consultation failure fails the planning request closed — a
      //     malformed/unversioned signal NEVER enters a decision record
      //     (M13) and planning never silently degrades on corrupt
      //     learning data.
      let learningConsultation: LearningConsultation | undefined;
      if (deps.learningSignals !== undefined) {
        const subjectKeys = [
          ...new Set(
            admissibleCandidates.flatMap((candidate) =>
              candidate.plan.steps.flatMap((step) =>
                step.routeRef === undefined
                  ? []
                  : [`${step.routeRef.provider}/${step.routeRef.model}`],
              ),
            ),
          ),
        ];
        const consultedSignals =
          subjectKeys.length === 0
            ? []
            : await deps.learningSignals.consult({
                applicationId: input.applicationId,
                tenantId: input.tenantId,
                taskClass: profile.kind,
                subjectKeys,
              });
        learningConsultation = buildLearningConsultation({
          candidates: admissibleCandidates,
          signals: consultedSignals,
          selectedStrategyId: selected.strategyId,
          consultedAt: iso(),
        });
      }

      // 7.6 OPTIONAL composition-recommendation consultation
      //     (WORK-017) — READ ONLY, AFTER the governed selection: the
      //     consultation is captured as decision evidence; it cannot
      //     change `selected` (already computed above), cannot revive
      //     an inadmissible candidate and cannot revisit the
      //     deterministic-sufficiency decision (M1/M18/M23 — the
      //     preference is recorded evidence, never applied). Every
      //     recommendation's tools are re-checked against the CURRENT
      //     effective policy at consultation time (M5: a forbidden
      //     tool never becomes preferred regardless of its learning
      //     score). A consultation failure fails the planning request
      //     closed — a malformed/unversioned recommendation NEVER
      //     enters a decision record (M11/M12/M13/M26) and planning
      //     never silently degrades on corrupt learning data.
      let compositionConsultation: CompositionConsultation | undefined;
      if (deps.compositionRecommendations !== undefined) {
        const consultedRecommendations = await deps.compositionRecommendations.consult({
          applicationId: input.applicationId,
          tenantId: input.tenantId,
          taskClass: profile.kind,
        });
        compositionConsultation = buildCompositionConsultation({
          candidates: admissibleCandidates,
          recommendations: consultedRecommendations,
          policy: policy.effective ?? {},
          selectedStrategyId: selected.strategyId,
          consultedAt: iso(),
        });
      }

      // 7.7 OPTIONAL substrate selection (WORK-031 / CSX-003) — AFTER
      //     policy inputs (step 4), capability resolution (step 5),
      //     deterministic-first sufficiency (step 6) and the governed
      //     selection (step 7): the ordering is structural, and the
      //     record carries the ordering evidence. DETERMINISTIC-FIRST
      //     APPLIED BEFORE SUBSTRATE SELECTION: a sufficient strategy
      //     needs no substrate at all (ADR-0016 invariant 4). The
      //     selection is evidence — it never changes `selected` and
      //     never dispatches anything.
      let substrateSelection: SubstrateSelection | undefined;
      const declaredWorkloadClass = input.task?.workloadClass;
      if (
        deps.substrateCatalog !== undefined &&
        typeof declaredWorkloadClass === "string" &&
        isWorkloadClass(declaredWorkloadClass)
      ) {
        const after = {
          policyInputsCaptured: true,
          capabilityResolutionCaptured: true,
          deterministicSufficiencyApplied: true,
        };
        if (sufficiency.outcome === "sufficient") {
          substrateSelection = validateSubstrateSelection({
            outcome: "no-substrate-required",
            workloadClass: declaredWorkloadClass,
            admissible: [],
            inadmissible: [],
            selected: null,
            rationale:
              "the selected strategy is deterministic-sufficient; deterministic-first planning requires no computational substrate",
            after,
          });
        } else {
          const entries = await deps.substrateCatalog.listAvailable(
            input.applicationId,
            declaredWorkloadClass,
          );
          const admissible: import("../domain/substrate-selection").SubstrateCandidate[] = [];
          const inadmissible: import("../domain/substrate-selection").SubstrateRejection[] = [];
          const isolationFloor = policy.effective?.isolation?.minIsolation ?? "none";
          const costCeilingMicroUsd = policy.effective?.cost?.maxCostMicroUsd;
          for (const entry of entries) {
            if (entry.status !== "available") {
              inadmissible.push({
                substrateId: entry.substrateId,
                version: entry.version,
                reason: "substrate-suspended",
                detail: `status ${entry.status}`,
              });
              continue;
            }
            if (!entry.workloadClasses.includes(declaredWorkloadClass)) {
              inadmissible.push({
                substrateId: entry.substrateId,
                version: entry.version,
                reason: "workload-class-unsupported",
                detail: "the catalog entry does not serve the declared workload class",
              });
              continue;
            }
            if (costCeilingMicroUsd !== undefined && entry.resource.estimatedCostMicroUsd !== "0") {
              const ceiling = Number(costCeilingMicroUsd);
              if (Number(entry.resource.estimatedCostMicroUsd) > ceiling) {
                inadmissible.push({
                  substrateId: entry.substrateId,
                  version: entry.version,
                  reason: "cost-above-ceiling",
                  detail: `estimated ${entry.resource.estimatedCostMicroUsd} above the policy ceiling ${costCeilingMicroUsd}`,
                });
                continue;
              }
            }
            admissible.push({
              substrateId: entry.substrateId,
              version: entry.version,
              adapterRef: entry.adapterRef,
              resource: entry.resource,
              isolation: entry.isolation,
              latencyClass: entry.latencyClass,
            });
          }
          // Deterministic selection policy: catalog order (first
          // admissible) — never a popularity/heuristic choice, and
          // the isolation floor is applied as an admissibility filter.
          const selectable = admissible.filter(
            (candidate) => isolationRank(candidate.isolation) >= isolationRank(isolationFloor),
          );
          for (const candidate of admissible) {
            if (!selectable.includes(candidate)) {
              inadmissible.push({
                substrateId: candidate.substrateId,
                version: candidate.version,
                reason: "isolation-below-policy",
                detail: `isolation ${candidate.isolation} below the policy floor ${isolationFloor}`,
              });
            }
          }
          const chosen = selectable[0];
          substrateSelection = validateSubstrateSelection({
            outcome: chosen === undefined ? "none-admissible" : "selected",
            workloadClass: declaredWorkloadClass,
            admissible: selectable,
            inadmissible,
            selected:
              chosen === undefined
                ? null
                : { substrateId: chosen.substrateId, version: chosen.version },
            rationale:
              chosen === undefined
                ? "no available substrate satisfies the declared workload class and the policy constraints"
                : `first admissible substrate in deterministic catalog order (workload class ${declaredWorkloadClass})`,
            after,
          });
        }
      }

      // 7.8 OPTIONAL codebase-opportunity consultation (WORK-022 /
      //     DTR-005) — READ ONLY, AFTER the governed selection: the
      //     consultation is captured as decision evidence; it cannot
      //     change `selected` (already computed above), cannot revive
      //     an inadmissible candidate and cannot revisit the
      //     deterministic-sufficiency decision (M17: recommendation ≠
      //     planner decision ≠ authorization — the implied preference
      //     is recorded evidence, never applied). A consultation
      //     failure fails the planning request closed — a
      //     malformed/unversioned finding NEVER enters a decision
      //     record (M11/M12/M13) and planning never silently degrades
      //     on corrupt learning data.
      let opportunityConsultation: OpportunityConsultation | undefined;
      if (deps.opportunitySignals !== undefined) {
        const consultedFindings = await deps.opportunitySignals.consult({
          applicationId: input.applicationId,
          tenantId: input.tenantId,
        });
        opportunityConsultation = buildOpportunityConsultation({
          candidates: admissibleCandidates,
          findings: consultedFindings,
          selectedStrategyId: selected.strategyId,
          consultedAt: iso(),
        });
      }

      // 7.9 OPTIONAL deterministicization consultation (WORK-021 /
      //     DTR-001..004) — READ ONLY, AFTER the governed selection: the
      //     consultation is captured as decision evidence; it cannot
      //     change `selected` (already computed above), cannot revive
      //     an inadmissible candidate and cannot revisit the
      //     deterministic-sufficiency decision (M17: a promoted
      //     replacement is an input to FUTURE plan composition, never a
      //     live-route rewrite — DTR-003's "without changing execution
      //     identity"). A consultation failure fails the planning
      //     request closed — an unprovenanced candidate NEVER enters a
      //     decision record and planning never silently degrades on
      //     corrupt learning data.
      let deterministicizationConsultation: DeterministicizationConsultation | undefined;
      if (deps.deterministicizationSignals !== undefined) {
        const consultedCandidates = await deps.deterministicizationSignals.consult({
          applicationId: input.applicationId,
          tenantId: input.tenantId,
        });
        deterministicizationConsultation = buildDeterministicizationConsultation({
          candidates: admissibleCandidates,
          signals: consultedCandidates,
          selectedStrategyId: selected.strategyId,
          consultedAt: iso(),
        });
      }

      // 8. The durable decision record (validated closed shape, then the
      //    executions ledger appends it — single write path). The
      //    decisionId is CONTENT-DERIVED (digest over the request identity
      //    + profile + selection): a retry of the same logical planning
      //    request derives the SAME decision id and replays the durable
      //    decision (idempotent plan creation), while any semantic change
      //    diverges the identity and fails IDEMPOTENCY_KEY_REUSED.
      const decisionId = digestValue({
        decisionSchema: 1,
        executionId: input.executionId,
        replanOf: input.replanOf ?? null,
        profileDigest: profile.profileDigest,
        selectedStrategyId: selected.strategyId,
        planId: selected.plan.planId,
      });
      const recordWithoutDigest = {
        decisionId,
        executionId: input.executionId,
        applicationId: input.applicationId,
        tenantId: input.tenantId,
        plannerVersion: PLANNER_VERSION,
        taskProfile: profile,
        policyInputs: {
          outcome: policy.outcome,
          ...(policy.effective === undefined ? {} : { effective: policy.effective }),
          ...(policy.policySetId === undefined ? {} : { policySetId: policy.policySetId }),
          ...(policy.policySetVersion === undefined
            ? {}
            : { policySetVersion: policy.policySetVersion }),
          ...(policy.policyContentHash === undefined
            ? {}
            : { policyContentHash: policy.policyContentHash }),
          ...(policy.appliedScopes === undefined ? {} : { appliedScopes: policy.appliedScopes }),
          restrictionSetDigest: digestValue({ restrictionSet: policy.effective ?? {} }),
        },
        capabilityResolution: {
          satisfied: resolution.satisfied,
          catalogRevision: resolution.catalogRevision,
          satisfiedIds: resolution.satisfied
            ? resolution.satisfactions.map((satisfaction) => satisfaction.requirementId)
            : [],
          unmetIds: resolution.satisfied
            ? []
            : resolution.unmet.map((unmet) => unmet.requirementId),
        },
        deterministicSufficiency: sufficiency,
        candidates: admissibleCandidates,
        selectedStrategyId: selected.strategyId,
        selectionRationale: selection.rationale,
        subgraphEvidence,
        ...(learningConsultation === undefined ? {} : { learningConsultation }),
        ...(compositionConsultation === undefined ? {} : { compositionConsultation }),
        ...(learnedPolicyConsultation === undefined ? {} : { learnedPolicyConsultation }),
        ...(substrateSelection === undefined ? {} : { substrateSelection }),
        ...(opportunityConsultation === undefined ? {} : { opportunityConsultation }),
        ...(deterministicizationConsultation === undefined
          ? {}
          : { deterministicizationConsultation }),
        ...(input.replanOf === undefined ? {} : { replanOf: input.replanOf }),
        recordedAt: iso(),
      };
      const decision: PlanningDecisionRecord = {
        ...recordWithoutDigest,
        recordDigest: decisionRecordDigest(recordWithoutDigest, digestValue),
      };
      validatePlanningDecision(decision);

      const outcome = await deps.sink.record({
        decision,
        actorId: input.actorId,
        idempotencyKey,
      });

      // On replay the DURABLE record is authoritative (volatile fields
      // like recordedAt come from the persisted envelope).
      const returnedDecision =
        outcome.replayed && outcome.durableRecord ? outcome.durableRecord : decision;

      return {
        decision: returnedDecision,
        selectedPlan: selected.plan,
        replayed: outcome.replayed,
        sequence: outcome.sequence,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Candidate composition (pure builders over the domain).
// ---------------------------------------------------------------------------

interface ComposeInput {
  readonly profile: TaskProfile;
  readonly sufficiency: DeterministicSufficiencyDecision;
  readonly catalog: readonly DeterministicCatalogEntry[];
  readonly routes: readonly ModelRouteCandidate[];
  readonly digest: (value: unknown) => string;
}

function microAdd(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString(10);
}

/** Ceil((1 - quality) * cost) as an integer micro-USD string. */
function microFractionCeil(quality: number, cost: string): string {
  const costBig = BigInt(cost);
  // scale by 1e6 to keep integer math: ceil(cost * (1-q)) with q in [0,1]
  const scaled = costBig * 1_000_000n;
  const remaining = scaled - (scaled * BigInt(Math.round(quality * 1_000_000))) / 1_000_000n;
  const ceiled = (remaining + 999_999n) / 1_000_000n;
  return ceiled.toString(10);
}

function composeCandidates(
  input: ComposeInput,
): readonly Omit<CandidateStrategy, "admissible" | "inadmissibleReason">[] {
  const { profile, sufficiency, routes, digest } = input;
  const candidates: Omit<CandidateStrategy, "admissible" | "inadmissibleReason">[] = [];
  const covered = sufficiency.coverage
    .filter((item) => item.covered && item.catalogEntry !== undefined)
    .map((item) => item.catalogEntry)
    .filter((entry): entry is DeterministicCatalogEntry => entry !== undefined);

  const deterministicPlan = buildDeterministicPlan(covered, digest);
  if (deterministicPlan !== null) {
    const quality = Math.min(...covered.map((entry) => entry.expectedQuality), 1);
    const cost = covered.reduce((sum, entry) => microAdd(sum, entry.expectedCostMicroUsd), "0");
    const latency = covered.reduce((sum, entry) => sum + entry.expectedLatencyMs, 0);
    candidates.push({
      strategyId: "deterministic-only",
      plan: deterministicPlan,
      expectedCostMicroUsd: cost,
      expectedQuality: quality,
      expectedLatencyMs: latency,
      verificationStrategy:
        covered.find((entry) => entry.verificationStrategy)?.verificationStrategy ??
        "composite-deterministic-verification",
      routeRationale: {
        code: "deterministic-sufficient",
        detail:
          "deterministic capabilities cover every non-semantic requirement of the task profile",
      },
      modelCalls: deterministicPlan.modelCalls,
    });
  }

  if (sufficiency.outcome === "sufficient") {
    // Deterministic is preferred; NO generative candidate is composed and
    // the route explorer is never consulted (spy-provable).
    return candidates;
  }

  // A generative route is REQUIRED (insufficient) or being compared
  // (uncertain — bounded evaluation).
  const modelRequirements = profile.capabilityRequirements.filter(
    (requirement) => requirement.kind === "model",
  );
  const capableRoutes = routes.filter((route) =>
    modelRequirements.every((requirement) => route.satisfies.includes(requirement.id)),
  );

  if (capableRoutes.length === 0) {
    // No route can satisfy the model requirements: only the deterministic
    // candidates (if any) remain — an empty set yields the typed
    // `NO_ELIGIBLE_ROUTE` at selection (fail closed, never fabricated).
    return candidates;
  }

  // Compose generative / hybrid / cascade / bounded-evaluation candidates
  // for EVERY capable route (the selection layer applies policy filters —
  // forbidden providers never survive filtering regardless of price).
  for (const route of capableRoutes) {
    const routeKey = `${route.provider}/${route.model}`;

    // Pure generative candidate.
    const generativePlan = buildPlan(
      {
        revision: 1,
        strategyClass: "generative",
        steps: [
          {
            id: "model",
            stepClass: "call-model",
            capabilityId: modelRequirements[0]?.id ?? "text-generation",
            routeRef: { provider: route.provider, model: route.model },
          },
          {
            id: "verify",
            stepClass: "verify",
            verificationStrategy: "policy-and-schema-verification",
          },
        ],
        edges: [{ from: "model", to: "verify" }],
      },
      digest,
    );
    candidates.push({
      strategyId: `generative:${routeKey}`,
      plan: generativePlan,
      expectedCostMicroUsd: route.expectedCostMicroUsd,
      expectedQuality: route.expectedQuality,
      expectedLatencyMs: route.expectedLatencyMs,
      verificationStrategy: "policy-and-schema-verification",
      routeRationale: {
        code: "semantic-reasoning-required",
        detail: `semantic reasoning requires generative inference (route ${routeKey})`,
      },
      modelCalls: generativePlan.modelCalls,
    });

    // Hybrid candidate (deterministic envelope around the model call).
    if (deterministicPlan !== null) {
      const hybridPlan = buildPlan(
        {
          revision: 1,
          strategyClass: "hybrid",
          steps: [
            ...covered.map((entry, index) => ({
              id: `det-${index}`,
              stepClass: stepClassForCatalogKind(entry),
              capabilityId: entry.capabilityId,
              verificationStrategy: entry.verificationStrategy,
            })),
            {
              id: "model",
              stepClass: "call-model",
              capabilityId: modelRequirements[0]?.id ?? "text-generation",
              routeRef: { provider: route.provider, model: route.model },
            },
            {
              id: "verify",
              stepClass: "verify",
              verificationStrategy: "deterministic-post-validation",
            },
          ],
          edges: [
            ...covered.map((_, index) => ({
              from: `det-${index}`,
              to: index === covered.length - 1 ? "model" : `det-${index + 1}`,
            })),
            { from: "model", to: "verify" },
          ],
        },
        digest,
      );
      const detCost = covered.reduce(
        (sum, entry) => microAdd(sum, entry.expectedCostMicroUsd),
        "0",
      );
      candidates.push({
        strategyId: `hybrid:${routeKey}`,
        plan: hybridPlan,
        expectedCostMicroUsd: microAdd(detCost, route.expectedCostMicroUsd),
        expectedQuality: Math.min(
          route.expectedQuality,
          ...covered.map((entry) => entry.expectedQuality),
        ),
        expectedLatencyMs:
          route.expectedLatencyMs +
          covered.reduce((sum, entry) => sum + entry.expectedLatencyMs, 0),
        verificationStrategy: "deterministic-post-validation",
        routeRationale: {
          code: "hybrid-composition",
          detail: `deterministic preprocessing/validation surrounds generative reasoning (route ${routeKey})`,
        },
        modelCalls: hybridPlan.modelCalls,
      });

      // Cheap-first cascade: deterministic first, escalate on failure.
      const cascadePlan = buildPlan(
        {
          revision: 1,
          strategyClass: "cascade",
          steps: [
            ...covered.map((entry, index) => ({
              id: `det-${index}`,
              stepClass: stepClassForCatalogKind(entry),
              capabilityId: entry.capabilityId,
              verificationStrategy: entry.verificationStrategy,
            })),
            {
              id: "verify-det",
              stepClass: "verify",
              verificationStrategy: "deterministic-verification",
            },
            {
              id: "pass-exit",
              stepClass: "terminate",
              config: { outcome: "deterministic-success" },
            },
            { id: "escalate", stepClass: "escalate" },
            {
              id: "model",
              stepClass: "call-model",
              capabilityId: modelRequirements[0]?.id ?? "text-generation",
              routeRef: { provider: route.provider, model: route.model },
            },
            {
              id: "verify-final",
              stepClass: "verify",
              verificationStrategy: "policy-and-schema-verification",
            },
          ],
          edges: [
            ...covered.map((_, index) => ({
              from: `det-${index}`,
              to: index === covered.length - 1 ? "verify-det" : `det-${index + 1}`,
            })),
            { from: "verify-det", to: "pass-exit" },
            { from: "verify-det", to: "escalate" },
            { from: "escalate", to: "model" },
            { from: "model", to: "verify-final" },
          ],
        },
        digest,
      );
      const detQuality = Math.min(...covered.map((entry) => entry.expectedQuality), 1);
      candidates.push({
        strategyId: `cascade:${routeKey}`,
        plan: cascadePlan,
        expectedCostMicroUsd: microAdd(
          detCost,
          microFractionCeil(detQuality, route.expectedCostMicroUsd),
        ),
        expectedQuality: Math.max(detQuality, route.expectedQuality),
        expectedLatencyMs:
          covered.reduce((sum, entry) => sum + entry.expectedLatencyMs, 0) +
          route.expectedLatencyMs,
        verificationStrategy: "cascade-verification (deterministic then escalated)",
        routeRationale: {
          code: "cheap-first-cascade",
          detail: `deterministic execution first with escalation to route ${routeKey} only on verification failure (INT-004)`,
        },
        modelCalls: cascadePlan.modelCalls,
      });
    }

    // Bounded evaluation (uncertain determinism): compare deterministic
    // output against a bounded model sample instead of blind escalation.
    if (sufficiency.outcome === "uncertain" && deterministicPlan !== null) {
      const boundedPlan = buildPlan(
        {
          revision: 1,
          strategyClass: "bounded-evaluation",
          steps: [
            ...covered.map((entry, index) => ({
              id: `det-${index}`,
              stepClass: stepClassForCatalogKind(entry),
              capabilityId: entry.capabilityId,
              verificationStrategy: entry.verificationStrategy,
            })),
            {
              id: "model-sample",
              stepClass: "call-model",
              capabilityId: modelRequirements[0]?.id ?? "text-generation",
              routeRef: { provider: route.provider, model: route.model },
              config: { purpose: "bounded-comparison-sample" },
            },
            {
              id: "compare",
              stepClass: "compare",
              verificationStrategy: "bounded-differential-evaluation",
            },
            { id: "verify", stepClass: "verify", verificationStrategy: "bounded-evaluation-gate" },
          ],
          edges: [
            ...covered.map((_, index) => ({
              from: `det-${index}`,
              to: index === covered.length - 1 ? "model-sample" : `det-${index + 1}`,
            })),
            { from: "model-sample", to: "compare" },
            { from: "compare", to: "verify" },
          ],
        },
        digest,
      );
      const detCost = covered.reduce(
        (sum, entry) => microAdd(sum, entry.expectedCostMicroUsd),
        "0",
      );
      candidates.push({
        strategyId: `bounded-evaluation:${routeKey}`,
        plan: boundedPlan,
        expectedCostMicroUsd: microAdd(detCost, route.expectedCostMicroUsd),
        expectedQuality: Math.min(
          ...covered.map((entry) => entry.expectedQuality),
          route.expectedQuality,
        ),
        expectedLatencyMs:
          route.expectedLatencyMs +
          covered.reduce((sum, entry) => sum + entry.expectedLatencyMs, 0),
        verificationStrategy: "bounded-evaluation-gate",
        routeRationale: {
          code: "bounded-evaluation-of-uncertain-determinism",
          detail: `deterministic sufficiency is uncertain — bounded comparison against route ${routeKey} resolves the uncertainty instead of unconditional escalation (ADR-0012)`,
        },
        modelCalls: boundedPlan.modelCalls,
      });
    }
  }

  return candidates;
}

function stepClassForCatalogKind(
  entry: DeterministicCatalogEntry,
): "run-algorithm" | "retrieve" | "call-tool" | "run-program" {
  switch (entry.kind) {
    case "data":
      return "retrieve";
    case "tool":
      return "call-tool";
    case "runtime":
      return "run-program";
    default:
      return "run-algorithm";
  }
}

function buildDeterministicPlan(
  covered: readonly DeterministicCatalogEntry[],
  digest: (value: unknown) => string,
): ExecutionPlan | null {
  if (covered.length === 0) {
    return null;
  }
  return buildPlan(
    {
      revision: 1,
      strategyClass: "deterministic-only",
      steps: [
        ...covered.map((entry, index) => ({
          id: `det-${index}`,
          stepClass: stepClassForCatalogKind(entry),
          capabilityId: entry.capabilityId,
          verificationStrategy: entry.verificationStrategy,
        })),
        {
          id: "verify",
          stepClass: "verify",
          verificationStrategy:
            covered.find((entry) => entry.verificationStrategy)?.verificationStrategy ??
            "composite-deterministic-verification",
        },
      ],
      edges: [
        ...covered.map((_, index) => ({
          from: `det-${index}`,
          to: index === covered.length - 1 ? "verify" : `det-${index + 1}`,
        })),
      ],
    },
    digest,
  );
}

export type { RouteRationale };
