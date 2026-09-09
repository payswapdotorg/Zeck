/**
 * Optimization constraint model unit tests (WORK-049).
 *
 * Proves: closed vocabularies, authority-provenance coherence, the
 * hard-by-construction rule for authority-sourced restrictions (a soft
 * policy/budget/capability/verification constraint is unrepresentable),
 * soft constraints never enforced, and every hard-constraint enforcement
 * check (policy routes/tools, budget ceilings, quality floors, latency
 * ceilings, capability satisfaction, verification anchors,
 * side-effect bounds).
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import {
  buildPlan,
  createNodeDigest as planningDigest,
} from "../../../../src/modules/planning/public";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import {
  CONSTRAINT_AUTHORITIES,
  CONSTRAINT_ENFORCEMENTS,
  CONSTRAINT_KINDS,
  CONSTRAINT_VIOLATION_CODES,
  ConstraintValidationError,
  enforceHardConstraints,
  routeAllowedByPolicy,
  validateConstraintSet,
  validateOptimizationConstraint,
} from "../../../../src/platform/execution-ir/constraints";
import { deriveExecutionIr } from "../../../../src/platform/execution-ir/ir";

const nodeDigest = planningDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

function irFor(
  steps: Parameters<typeof buildPlan>[0]["steps"],
  edges: Parameters<typeof buildPlan>[0]["edges"],
) {
  const plan = buildPlan({ revision: 1, strategyClass: "hybrid", steps, edges }, digestValue);
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

const BASE_STEPS = [
  {
    id: "fetch-docs",
    stepClass: "retrieve",
    capabilityId: "document-retrieval",
  } as const,
  {
    id: "summarize",
    stepClass: "call-model",
    capabilityId: "text-generation",
    routeRef: { provider: "rail-a", model: "model-x" },
  } as const,
  { id: "check-output", stepClass: "verify", verificationStrategy: "schema-check" } as const,
];

const BASE_EDGES = [
  { from: "fetch-docs", to: "summarize" },
  { from: "summarize", to: "check-output" },
] as const;

const policySource = {
  authority: "policy" as const,
  policySetId: "ps-1",
  policySetVersion: 4,
};

function constraint(overrides: Record<string, unknown> = {}): OptimizationConstraint {
  return {
    constraintId: "policy-eligibility",
    kind: "policy",
    enforcement: "hard",
    source: policySource,
    payload: { providerModel: { deniedProviders: ["rail-b"] } },
    ...overrides,
  } as OptimizationConstraint;
}

describe("optimization constraints (WORK-049)", () => {
  test("closed vocabularies", () => {
    expect([...CONSTRAINT_KINDS]).toEqual([
      "policy",
      "capability",
      "budget",
      "quality",
      "latency",
      "verification",
      "side-effect",
    ]);
    expect([...CONSTRAINT_ENFORCEMENTS]).toEqual(["hard", "soft"]);
    expect([...CONSTRAINT_AUTHORITIES]).toEqual([
      "policy",
      "capability",
      "budget",
      "verification",
      "planning",
    ]);
    expect(CONSTRAINT_VIOLATION_CODES.length).toBe(8);
  });

  test("valid constraints round-trip validation; sets enforce id uniqueness", () => {
    const valid = validateOptimizationConstraint(constraint());
    expect(valid.constraintId).toBe("policy-eligibility");

    const set = validateConstraintSet([
      constraint(),
      {
        constraintId: "budget-monthly",
        kind: "budget",
        enforcement: "hard",
        source: { authority: "budget", budgetId: "b-1", scopeKind: "monthly" },
        payload: { maxCostMicroUsd: "500000" },
      },
    ]);
    expect(set.length).toBe(2);

    // Duplicate ids are rejected.
    expect(() => validateConstraintSet([constraint(), constraint()])).toThrow(
      ConstraintValidationError,
    );
  });

  test("unknown vocabularies are rejected (typed)", () => {
    expect(() =>
      validateOptimizationConstraint(constraint({ kind: "vendor-e2b-warm-pool" })),
    ).toThrow(ConstraintValidationError);
    expect(() => validateOptimizationConstraint(constraint({ enforcement: "maybe" }))).toThrow(
      ConstraintValidationError,
    );
    expect(() =>
      validateOptimizationConstraint(
        constraint({ source: { ...policySource, authority: "openrouter" } }),
      ),
    ).toThrow(ConstraintValidationError);
  });

  test("authority restrictions are hard by construction (weakened protection rejected)", () => {
    // A soft POLICY constraint is unrepresentable.
    expect(() => validateOptimizationConstraint(constraint({ enforcement: "soft" }))).toThrow(
      ConstraintValidationError,
    );
    try {
      validateOptimizationConstraint(constraint({ enforcement: "soft" }));
    } catch (error) {
      expect((error as ConstraintValidationError).invariant).toBe("constraint-authority-mismatch");
    }
    // Likewise budget, capability and verification sources.
    for (const [kind, source, payload] of [
      [
        "budget",
        { authority: "budget", budgetId: "b", scopeKind: "monthly" },
        { maxCostMicroUsd: "1" },
      ],
      [
        "capability",
        { authority: "capability", catalogRevision: "r1" },
        { satisfiedIds: [], unmetIds: [] },
      ],
      ["verification", { authority: "verification" }, { requiresVerificationAnchor: true }],
    ] as const) {
      expect(() =>
        validateOptimizationConstraint(
          constraint({ kind, source, payload, enforcement: "soft" as const }),
        ),
      ).toThrow(ConstraintValidationError);
    }
    // Planning-sourced task preferences may be soft.
    const soft = validateOptimizationConstraint(
      constraint({
        constraintId: "task-latency-preference",
        kind: "latency",
        enforcement: "soft",
        source: { authority: "planning" },
        payload: { maxLatencyMs: 4000 },
      }),
    );
    expect(soft.enforcement).toBe("soft");
  });

  test("kind/authority coherence is enforced", () => {
    // A capability-sourced POLICY constraint is incoherent.
    expect(() =>
      validateOptimizationConstraint(
        constraint({ source: { authority: "capability", catalogRevision: "r1" } }),
      ),
    ).toThrow(ConstraintValidationError);
    // A budget-sourced capability constraint is incoherent.
    expect(() =>
      validateOptimizationConstraint(
        constraint({
          kind: "capability",
          source: { authority: "budget", budgetId: "b", scopeKind: "monthly" },
          payload: { satisfiedIds: [], unmetIds: [] },
        }),
      ),
    ).toThrow(ConstraintValidationError);
  });

  test("policy route enforcement mirrors the planning semantics", () => {
    expect(routeAllowedByPolicy("rail-a", "model-x", { deniedProviders: ["rail-b"] })).toBe(true);
    expect(routeAllowedByPolicy("rail-b", "model-x", { deniedProviders: ["rail-b"] })).toBe(false);
    expect(
      routeAllowedByPolicy("rail-a", "model-x", {
        allowedProviders: ["rail-c"],
      }),
    ).toBe(false);
    expect(routeAllowedByPolicy("rail-a", "model-y", { deniedModels: ["model-y"] })).toBe(false);
    expect(routeAllowedByPolicy("rail-a", "model-x", { allowedModels: ["model-x"] })).toBe(true);
  });

  test("hard policy route constraints are enforced against the IR", () => {
    const ir = irFor(BASE_STEPS, BASE_EDGES);
    const denied = enforceHardConstraints(
      ir,
      [],
      [constraint({ payload: { providerModel: { deniedProviders: ["rail-a"] } } })],
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.code).toBe("policy-forbidden-route");
    expect(denied[0]?.constraintId).toBe("policy-eligibility");

    const allowed = enforceHardConstraints(
      ir,
      [],
      [constraint({ payload: { providerModel: { allowedProviders: ["rail-a"] } } })],
    );
    expect(allowed).toEqual([]);
  });

  test("hard policy tool constraints are enforced against call-tool steps", () => {
    const ir = irFor(
      [
        ...BASE_STEPS,
        {
          id: "invoke-search",
          stepClass: "call-tool",
          capabilityId: "web-search",
        } as const,
      ],
      [...BASE_EDGES, { from: "check-output", to: "invoke-search" }],
    );
    const denied = enforceHardConstraints(
      ir,
      [],
      [constraint({ payload: { tool: { deniedTools: ["web-search"] } } })],
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.code).toBe("policy-forbidden-tool");
    const allowed = enforceHardConstraints(
      ir,
      [],
      [constraint({ payload: { tool: { allowedTools: ["web-search"] } } })],
    );
    expect(allowed).toEqual([]);
  });

  test("budget ceilings, quality floors and latency ceilings are enforced against claims", () => {
    const ir = irFor(BASE_STEPS, BASE_EDGES);
    const claim = {
      expectedCostMicroUsd: "600000",
      expectedLatencyMs: 5000,
      expectedQuality: 0.8,
      expectedReliability: 0.9,
      basis: { basis: "estimated" as const, source: "planning.route-table" },
    };
    const candidate = {
      candidateId: "candidate-a",
      representationClass: "sufficient-model" as const,
      claim,
    };
    const violations = enforceHardConstraints(
      ir,
      [candidate],
      [
        constraint({
          constraintId: "budget-monthly",
          kind: "budget",
          source: { authority: "budget", budgetId: "b", scopeKind: "monthly" },
          payload: { maxCostMicroUsd: "500000" },
        }),
        constraint({
          constraintId: "quality-floor",
          kind: "quality",
          source: policySource,
          payload: { minQuality: 0.85 },
        }),
        constraint({
          constraintId: "latency-ceiling",
          kind: "latency",
          source: policySource,
          payload: { maxLatencyMs: 4000 },
        }),
      ],
    );
    expect(violations.map((violation) => violation.code).sort()).toEqual([
      "budget-ceiling",
      "latency-ceiling",
      "quality-floor",
    ]);
  });

  test("capability satisfaction is enforced against IR capability references", () => {
    const ir = irFor(BASE_STEPS, BASE_EDGES);
    const unmet = enforceHardConstraints(
      ir,
      [],
      [
        constraint({
          constraintId: "capability-satisfaction",
          kind: "capability",
          source: { authority: "capability", catalogRevision: "r1" },
          payload: {
            satisfiedIds: ["document-retrieval", "other-capability"],
            unmetIds: ["text-generation"],
          },
        }),
      ],
    );
    // summarize binds text-generation which is UNMET.
    expect(unmet).toHaveLength(1);
    expect(unmet[0]?.code).toBe("capability-unsatisfied");

    const outsideSet = enforceHardConstraints(
      ir,
      [],
      [
        constraint({
          constraintId: "capability-satisfaction",
          kind: "capability",
          source: { authority: "capability", catalogRevision: "r1" },
          payload: { satisfiedIds: ["document-retrieval"], unmetIds: [] },
        }),
      ],
    );
    // summarize binds text-generation OUTSIDE the satisfied set.
    expect(outsideSet).toHaveLength(1);
  });

  test("verification anchor requirement is enforced (frozen completion binding mirror)", () => {
    const withAnchor = irFor(BASE_STEPS, BASE_EDGES);
    expect(
      enforceHardConstraints(
        withAnchor,
        [],
        [
          constraint({
            constraintId: "verification-anchor",
            kind: "verification",
            source: { authority: "verification" },
            payload: { requiresVerificationAnchor: true },
          }),
        ],
      ),
    ).toEqual([]);

    const withoutAnchor = irFor(
      [
        {
          id: "fetch-docs",
          stepClass: "retrieve",
          capabilityId: "document-retrieval",
        } as const,
        {
          id: "summarize",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        } as const,
      ],
      [{ from: "fetch-docs", to: "summarize" }] as const,
    );
    const violations = enforceHardConstraints(
      withoutAnchor,
      [],
      [
        constraint({
          constraintId: "verification-anchor",
          kind: "verification",
          source: { authority: "verification" },
          payload: { requiresVerificationAnchor: true },
        }),
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("verification-anchor-missing");
  });

  test("side-effect constraints: egress none forbids external-effect steps; other dimensions carried", () => {
    const ir = irFor(
      [
        ...BASE_STEPS,
        {
          id: "invoke-tool",
          stepClass: "call-tool",
          capabilityId: "http-fetch",
        } as const,
      ],
      [...BASE_EDGES, { from: "check-output", to: "invoke-tool" }] as const,
    );
    const violations = enforceHardConstraints(
      ir,
      [],
      [
        constraint({
          constraintId: "policy-side-effect",
          kind: "side-effect",
          source: policySource,
          payload: { network: { egress: "none" } },
        }),
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("side-effect-class-forbidden");

    // Egress allowlist/open does not forbid the class at IR level.
    expect(
      enforceHardConstraints(
        ir,
        [],
        [
          constraint({
            constraintId: "policy-side-effect",
            kind: "side-effect",
            source: policySource,
            payload: { network: { egress: "open" } },
          }),
        ],
      ),
    ).toEqual([]);

    // Autonomy/secrets/isolation dimensions are carried and validated
    // without IR-level enforcement (their enforcement points are
    // dispatch/policy admission).
    expect(
      enforceHardConstraints(
        ir,
        [],
        [
          constraint({
            constraintId: "policy-side-effect",
            kind: "side-effect",
            source: policySource,
            payload: { autonomy: { maxAutonomy: "none" }, secrets: { access: "none" } },
          }),
        ],
      ),
    ).toEqual([]);
  });

  test("SOFT constraints are never enforced (recorded only)", () => {
    const ir = irFor(BASE_STEPS, BASE_EDGES);
    // A task-derived soft latency preference the claims violate: NO
    // violation is produced (soft constraints are recorded, never
    // silently enforced).
    const claim = {
      expectedCostMicroUsd: "100",
      expectedLatencyMs: 60_000,
      expectedQuality: 0.5,
      expectedReliability: 0.9,
      basis: { basis: "estimated" as const, source: "planning.route-table" },
    };
    const violations = enforceHardConstraints(
      ir,
      [{ candidateId: "candidate-a", representationClass: "sufficient-model" as const, claim }],
      [
        {
          constraintId: "task-latency-preference",
          kind: "latency",
          enforcement: "soft",
          source: { authority: "planning" },
          payload: { maxLatencyMs: 1000 },
        },
      ],
    );
    expect(violations).toEqual([]);
  });
});
