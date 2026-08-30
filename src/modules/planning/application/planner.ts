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
  DeterministicSufficiencyDecision,
  ExecutionPlan,
  PlanningDecisionRecord,
  RouteRationale,
  TaskConstraintInput,
  TaskProfile,
} from "../domain";
import {
  buildPlan,
  canonicalJson,
  decisionRecordDigest,
  deriveTaskProfile,
  emitSubgraphEvidence,
  evaluateDeterministicSufficiency,
  filterAdmissibility,
  PLANNER_VERSION,
  selectStrategy,
  validatePlanningDecision,
} from "../domain";
import type { PlanningCapabilityAuthority } from "../ports/capability-authority";
import type { DeterministicCatalogEntry } from "../ports/deterministic-catalog";
import type { DigestPort } from "../ports/digest";
import type { ModelRouteCandidate, ModelRouteExplorer } from "../ports/model-routes";
import type { PlanningDecisionSink } from "../ports/planning-sink";
import type { PlanningPolicyInputs } from "../ports/policy-inputs";

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
      const selection = selectStrategy(admissibleCandidates, sufficiency, profile.qualityTarget);
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

      // 7. Subgraph-level evidence (DTR-001/DTR-004).
      const routeCosts: Record<string, { costMicroUsd: string; quality: number }> = {};
      for (const route of routes) {
        routeCosts[`${route.provider}\u0000${route.model}`] = {
          costMicroUsd: route.expectedCostMicroUsd,
          quality: route.expectedQuality,
        };
      }
      const subgraphEvidence = emitSubgraphEvidence(selected.plan, catalog, routeCosts);

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
