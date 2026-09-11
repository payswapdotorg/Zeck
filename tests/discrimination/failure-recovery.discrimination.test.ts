/**
 * Discrimination / mutation battery (WORK-055): every architecture
 * invariant of the failure-recovery plane is PROVEN to discriminate —
 * a weakened or mutated protection is REJECTED, mechanically.
 *
 * The required battery (the Work Order's Discrimination section):
 *
 *  D1  GENERIC-FAILURE RETRY LOOPS ARE INADMISSIBLE — no attribution
 *      → no retry; no transient/class discipline → no retry; no
 *      economics → no retry. A retry decision that exists without its
 *      attributed cause and economic justification is unrepresentable.
 *  D2  CROSS-CLASSIFIED ATTRIBUTION IS REJECTED — an infrastructure
 *      signal blamed on intelligence (model quality) is a typed
 *      rejection (the ADR-0020 misattribution guard); evidence-kind
 *      mismatches and provider-signal incoherence reject too.
 *  D3  SILENT DRIFT APPLICATION IS REJECTED — a continuation package
 *      applied under a changed environment fails closed with the
 *      typed drift report (never a silently applied package).
 *  D4  CONTINUATION AS A SECOND STATE MACHINE IS IMPOSSIBLE — the
 *      plane holds no store/SQL/migration/lifecycle (mechanical
 *      source scan over the REAL tree) and applying a package twice
 *      is a bounded no-op with zero side effects.
 *  D5  NON-DETERMINISTIC TIE-BREAKS ARE DETECTED/REJECTED — equal-cost
 *      strategies resolve by the total order; mutated ordering inputs
 *      (input order, cost ties) never flip the selection; byte-level
 *      re-runs are identical.
 *  D6  RECOVERY BYPASSING AUTHORIZATION/BUD/POLICY IS IMPOSSIBLE —
 *      the plane exposes no admission vocabulary (mechanical scan);
 *      budget ceilings make over-budget strategies inadmissible; a
 *      policy-forbidden re-route route is not selectable through this
 *      plane's re-route facts (the economics planes' own admissibility
 *      governs, consumed not re-implemented).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../src/modules/planning/public";
import { canonicalJson } from "../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../src/platform/execution-ir/constraints";
import type { CostClaim } from "../../src/platform/execution-ir/cost-model";
import { deriveExecutionIr, type ExecutionIr } from "../../src/platform/execution-ir/ir";
import {
  attributeFailure,
  validateFailureAttribution,
} from "../../src/platform/failure-recovery/attribution";
import { FailureRecoveryError } from "../../src/platform/failure-recovery/catalog";
import {
  applyContinuationPackage,
  buildContinuationPackage,
} from "../../src/platform/failure-recovery/continuation";
import { buildRecoveryDecisionRecord } from "../../src/platform/failure-recovery/decisions";
import { fingerprintOf } from "../../src/platform/failure-recovery/fingerprint";
import type { RecoveryFacts, StrategyVerdict } from "../../src/platform/failure-recovery/strategy";
import {
  compareStrategies,
  selectRecoveryStrategy,
} from "../../src/platform/failure-recovery/strategy";
import { decideFreshEscalation } from "../../src/platform/model-economics/escalation-hooks";
import { selectModelRepresentation } from "../../src/platform/model-economics/model-selection";
import {
  deriveSelectionConstraints,
  selectSubstrate,
} from "../../src/platform/substrate-economics/selection";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeDigest = createNodeDigest();
const digest = nodeDigest;
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";

function governedIr(): ExecutionIr {
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

function constraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "quality-floor",
      kind: "quality",
      enforcement: "hard",
      source: { authority: "planning" },
      payload: { minQuality: 0.8 },
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

function infraAttribution() {
  return attributeFailure(
    {
      signal: "transport-unreachable",
      component: "edge-gateway",
      stepId: "generate",
      detail: "upstream unreachable",
      observedAt: "2026-09-23T08:59:00.000Z",
      observationDigest: digest.sha256Hex("observation:transport-unreachable"),
    },
    "infrastructure",
    { kind: "infrastructure", transient: true },
    digest,
  );
}

function intelligenceAttribution() {
  return attributeFailure(
    {
      signal: "verification-failed",
      component: "verification-authority",
      stepId: "verify",
      detail: "verifier FAIL",
      observedAt: "2026-09-23T08:59:00.000Z",
      observationDigest: digest.sha256Hex("observation:verification-failed"),
    },
    "intelligence",
    { kind: "intelligence", observedQuality: 0.4 },
    digest,
  );
}

function retryClaim(cost = "400") {
  return {
    expectedCostMicroUsd: cost,
    expectedLatencyMs: 2000,
    expectedQuality: 0.92,
    expectedReliability: 0.95,
    basis: { basis: "estimated" as const, source: "recovery:retry-path" },
  };
}

function modelReroute(governing: readonly OptimizationConstraint[]) {
  return selectModelRepresentation({
    ir: governedIr(),
    stepId: "generate",
    candidates: [
      {
        candidateId: "rail-b-model-y",
        route: { provider: "rail-b", model: "model-y" },
        representationClass: "sufficient-model" as const,
        claim: {
          expectedCostMicroUsd: "300",
          expectedLatencyMs: 1800,
          expectedQuality: 0.9,
          expectedReliability: 0.95,
          basis: { basis: "estimated" as const, source: "model-economics:route-table" },
        },
      },
    ],
    qualityFacts: { requiredQuality: 0.85 },
    constraints: governing,
  });
}

function substrateReroute(governing: readonly OptimizationConstraint[]) {
  const derived = deriveSelectionConstraints(governing);
  return selectSubstrate(
    {
      candidates: [
        {
          substrateId: "mid-container-b",
          version: "2.0.0",
          adapterRef: "substrate-adapter-02",
          isolation: "container",
          execution: {
            expectedCostMicroUsd: "200",
            expectedLatencyMs: 2000,
            expectedQuality: 0.88,
            expectedReliability: 0.93,
            basis: { basis: "observed" as const, source: "substrate-observer:container-fleet" },
          },
          startup: {
            cold: {
              readinessMs: 4000,
              startupCostMicroUsd: "60",
              basis: { basis: "estimated" as const, source: "substrate-facts:container-cold" },
            },
          },
          description: null,
        },
      ],
      constraints: derived.constraints,
      sourceConstraintIds: derived.sourceConstraintIds,
      recordedAt: "2026-09-23T09:00:00.000Z",
    },
    nodeDigest,
  );
}

function fullFacts(): RecoveryFacts {
  return {
    retry: { nextAttempt: 1, claim: retryClaim() },
    reroute: {
      model: {
        selection: modelReroute(constraints()),
        declaredCandidates: [
          {
            candidateId: "rail-b-model-y",
            route: { provider: "rail-b", model: "model-y" },
            representationClass: "sufficient-model" as const,
            claim: {
              expectedCostMicroUsd: "300",
              expectedLatencyMs: 1800,
              expectedQuality: 0.9,
              expectedReliability: 0.95,
              basis: { basis: "estimated" as const, source: "model-economics:route-table" },
            },
          },
        ],
      },
      substrate: { selection: substrateReroute(constraints()) },
    },
    escalation: null,
  };
}

function selectWith(
  attribution: Parameters<typeof selectRecoveryStrategy>[0]["attribution"],
  facts: RecoveryFacts,
  attemptsUsed = 0,
) {
  return selectRecoveryStrategy({
    attribution,
    context: { attemptsUsed, incumbentRoute: { provider: "rail-a", model: "model-x" } },
    facts,
    qualityFacts: { requiredQuality: 0.85 },
    constraints: constraints(),
    configuration: { maxRetryAttempts: 3, escalationEvidenceBound: 8, continuationStepBound: 32 },
    digest,
  });
}

function expectTypedReject(invariant: string, fn: () => unknown): FailureRecoveryError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FailureRecoveryError);
    const typed = error as FailureRecoveryError;
    expect(typed.invariant).toBe(invariant);
    return typed;
  }
  throw new Error("expected a typed rejection");
}

describe("failure-recovery discrimination battery (WORK-055)", () => {
  // D1 — generic-failure retry loops are inadmissible -------------------
  test("D1a no attribution → no recovery action (the selection input is unrepresentable)", () => {
    // A selection without its attribution fails closed before any
    // strategy exists: invariant 1 (attribution before action).
    expectTypedReject("attribution-shape", () =>
      selectRecoveryStrategy({
        attribution: { bogus: "generic failure" } as never,
        context: { attemptsUsed: 0 },
        facts: fullFacts(),
        qualityFacts: { requiredQuality: 0.85 },
        constraints: constraints(),
        configuration: {
          maxRetryAttempts: 3,
          escalationEvidenceBound: 8,
          continuationStepBound: 32,
        },
        digest,
      }),
    );
  });

  test("D1b an unattributed (evidence-less) failure never becomes a retry", () => {
    expectTypedReject("attribution-unattributed", () =>
      attributeFailure(
        {
          signal: "transport-unreachable",
          component: "edge-gateway",
          detail: "generic failure",
          observedAt: "2026-09-23T08:59:00.000Z",
          observationDigest: digest.sha256Hex("observation:generic"),
        },
        "infrastructure",
        undefined as never,
        digest,
      ),
    );
  });

  test("D1c an intelligence failure with a retry fact NEVER admits the retry (the runaway-token trap)", () => {
    const selection = selectWith(intelligenceAttribution(), fullFacts());
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.admissible).toBe(false);
    expect(retryVerdict?.inadmissibleCode).toBe("class-not-retryable");
    // And the fail-closed fallback exists when nothing else is offered.
    const bare = selectWith(intelligenceAttribution(), {
      retry: fullFacts().retry,
      reroute: { model: null, substrate: null },
      escalation: null,
    });
    expect(bare.kind).toBe("fail-closed");
  });

  test("D1d a retry without attempts remaining is inadmissible (bounded re-execution)", () => {
    const selection = selectWith(
      infraAttribution(),
      {
        ...fullFacts(),
        retry: { nextAttempt: 4, claim: retryClaim() },
      },
      3,
    );
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.inadmissibleCode).toBe("retry-attempt-bound");
  });

  // D2 — cross-classified attribution is rejected -----------------------
  test("D2a infrastructure failure blamed on model quality is inadmissible (the ADR-0020 guard)", () => {
    const error = expectTypedReject("attribution-cross-classified", () =>
      attributeFailure(
        {
          signal: "transport-unreachable",
          component: "edge-gateway",
          detail: "unreachable",
          observedAt: "2026-09-23T08:59:00.000Z",
          observationDigest: digest.sha256Hex("observation:transport-unreachable"),
        },
        "intelligence",
        { kind: "intelligence", observedQuality: 0.4 },
        digest,
      ),
    );
    expect(error.details.admissibleClasses).toBe("infrastructure");
  });

  test("D2b intelligence failure blamed on infrastructure is inadmissible", () => {
    expectTypedReject("attribution-cross-classified", () =>
      attributeFailure(
        {
          signal: "verification-failed",
          component: "verification-authority",
          detail: "verifier FAIL",
          observedAt: "2026-09-23T08:59:00.000Z",
          observationDigest: digest.sha256Hex("observation:verification-failed"),
        },
        "infrastructure",
        { kind: "infrastructure", transient: true },
        digest,
      ),
    );
  });

  test("D2c a tampered attribution value is rejected at read time (identity discipline)", () => {
    const attribution = infraAttribution();
    const tampered = JSON.parse(JSON.stringify(attribution));
    tampered.evidence.transient = false;
    expectTypedReject("attribution-shape", () => {
      // Re-validate the mutated value: the identity no longer digests.
      return validateFailureAttribution(tampered, digest);
    });
  });

  // D3 — silent drift application is rejected --------------------------
  test("D3 a changed environment NEVER resumes: the drift rejection is typed, never silent", () => {
    const environment = fingerprintOf(
      [
        { kind: "model-route", provider: "rail-a", model: "model-x" },
        { kind: "substrate", substrateId: "mid-container-b", version: "2.0.0" },
      ],
      digest,
    );
    const ir = governedIr();
    const pkg = buildContinuationPackage({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      planId: ir.planId,
      irId: ir.irId,
      steps: [{ stepId: "fetch", status: "completed" }],
      environment,
      createdAt: "2026-09-23T09:00:00.000Z",
      digest,
    });
    const drifted = fingerprintOf(
      [
        { kind: "model-route", provider: "rail-a", model: "model-y" },
        { kind: "substrate", substrateId: "mid-container-b", version: "2.0.0" },
      ],
      digest,
    );
    const error = expectTypedReject("continuation-drift", () =>
      applyContinuationPackage(pkg, drifted, digest),
    );
    expect(error.details.firstDrift).toContain("model-route:rail-a");
    // The untouched environment still resumes (the guard discriminates).
    const directive = applyContinuationPackage(pkg, environment, digest);
    expect(directive.completedStepIds).toEqual(["fetch"]);
  });

  // D4 — continuation as a second state machine is impossible ----------
  test("D4a the plane holds NO store, NO SQL, NO migration, NO lifecycle (mechanical scan)", () => {
    const planeDir = join(REPO_ROOT, "src/platform/failure-recovery");
    const files = readdirSync(planeDir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(join(planeDir, name), "utf8"));
    expect(files.length).toBe(8);
    for (const content of files) {
      expect(content).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/,
      );
      expect(content).not.toContain("DatabasePort");
      expect(content).not.toContain("SqlOptimizationDecisionStore");
      expect(content).not.toContain("implements OptimizationDecisionStore");
      expect(content).not.toContain("transitionTable");
      for (const state of ["CREATED", "RUNNING", "WAITING_HUMAN", "REPLANNING", "COMPLETED"]) {
        expect(content).not.toContain(`"${state}"`);
      }
    }
    // The migration set is unchanged (no new durable surface).
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations")).filter((name) =>
      name.endsWith(".sql"),
    );
    expect(migrations).toHaveLength(31); // +0031_isolation_profiles (WORK-058) +0032_audit_compliance (WORK-059 / D-08)
    expect(migrations[migrations.length - 1]).toMatch(/^0032_audit_compliance/); // WORK-059 / D-08
  });

  test("D4b applying a continuation twice is a bounded no-op (pure data, zero side effects)", () => {
    const environment = fingerprintOf(
      [{ kind: "model-route", provider: "rail-a", model: "model-x" }],
      digest,
    );
    const ir = governedIr();
    const pkg = buildContinuationPackage({
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      planId: ir.planId,
      irId: ir.irId,
      steps: [{ stepId: "fetch", status: "completed" }],
      environment,
      createdAt: "2026-09-23T09:00:00.000Z",
      digest,
    });
    const first = applyContinuationPackage(pkg, environment, digest);
    const second = applyContinuationPackage(pkg, environment, digest);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    // The package is un-mutated by application (data, never an engine).
    expect(pkg.packageId).toBe(
      buildContinuationPackage({
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        planId: ir.planId,
        irId: ir.irId,
        steps: [{ stepId: "fetch", status: "completed" }],
        environment,
        createdAt: "2026-09-23T09:00:00.000Z",
        digest,
      }).packageId,
    );
  });

  // D5 — non-deterministic tie-breaks are detected/rejected -------------
  test("D5a equal-cost ties resolve deterministically (rank, then candidateId) — never input order", () => {
    const verdict = (
      candidateId: string,
      strategy: StrategyVerdict["strategy"],
    ): StrategyVerdict => ({
      candidateId,
      strategy,
      attributionId: "0".repeat(64),
      representationClass: "sufficient-model",
      admissible: true,
      evaluation: {
        candidateId,
        representationClass: "sufficient-model",
        valid: true,
        expectedSuccessfulResolutionCostMicroUsd: "100",
        expectedLatencyMs: 0,
        qualityExpectation: { expectedQuality: 0.9, threshold: 0.8, meetsThreshold: true },
        basis: { basis: "estimated", source: "test:tie" },
      },
    });
    const a = verdict("a", "re-route");
    const b = verdict("z", "re-route");
    const c = verdict("m", "retry");
    const set = [a, b, c];
    // Any input permutation sorts to the SAME total order.
    for (const permutation of [set, [b, c, a], [c, a, b], [b, a, c]]) {
      const sorted = [...permutation].sort(compareStrategies);
      expect(sorted.map((v) => v.candidateId)).toEqual(["m", "a", "z"]);
    }
  });

  test("D5b byte-identical selections on re-run (idempotence proof)", () => {
    const first = selectWith(infraAttribution(), fullFacts());
    const second = selectWith(infraAttribution(), fullFacts());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const third = selectWith(intelligenceAttribution(), fullFacts());
    const fourth = selectWith(intelligenceAttribution(), fullFacts());
    expect(JSON.stringify(third)).toBe(JSON.stringify(fourth));
    expect(JSON.stringify(third)).not.toBe(JSON.stringify(first));
  });

  test("D5c a mutated comparison input produces a DIFFERENT selection (the order is load-bearing)", () => {
    // Same attribution, different retry economics → the winner flips:
    // the comparator provably reads the cost, not the input order.
    const cheap = selectWith(infraAttribution(), {
      retry: { nextAttempt: 1, claim: retryClaim() },
      reroute: { model: null, substrate: null },
      escalation: null,
    });
    const expensive = selectWith(infraAttribution(), {
      retry: { nextAttempt: 1, claim: retryClaim("200000") },
      reroute: { model: null, substrate: null },
      escalation: null,
    });
    expect(cheap.selected?.candidateId).toBe("retry-attempt-1");
    expect(expensive.selected?.candidateId).toBe("retry-attempt-1");
    // The winning COSTS differ — the comparator read the mutated claim.
    expect(cheap.selected?.evaluation?.expectedSuccessfulResolutionCostMicroUsd).not.toBe(
      expensive.selected?.evaluation?.expectedSuccessfulResolutionCostMicroUsd,
    );
    // And under the full corpus the expensive retry loses to re-route.
    const withAlternatives = selectWith(infraAttribution(), {
      ...fullFacts(),
      retry: { nextAttempt: 1, claim: retryClaim("200000") },
    });
    expect(withAlternatives.selected?.candidateId).not.toBe("retry-attempt-1");
  });

  // D6 — recovery bypassing authorities is impossible -------------------
  test("D6a the plane exposes NO authorization/admission vocabulary (mechanical scan)", () => {
    const planeDir = join(REPO_ROOT, "src/platform/failure-recovery");
    for (const name of readdirSync(planeDir).filter((n) => n.endsWith(".ts"))) {
      const content = readFileSync(join(planeDir, name), "utf8");
      for (const word of ["authorize", "admission", "approve", "reserve", "settle", "release"]) {
        expect(content, `${name} must not expose "${word}"`).not.toContain(`readonly ${word}`);
        expect(content, `${name} must not expose "${word}"`).not.toContain(`function ${word}`);
        expect(content, `${name} must not expose "${word}"`).not.toContain(`async ${word}`);
      }
    }
  });

  test("D6b budget ceilings bind recovery (no economically unjustified path)", () => {
    // A retry claim over the hard budget ceiling is inadmissible —
    // even though retry is the cheapest DISCIPLINE-wise path.
    const selection = selectWith(infraAttribution(), {
      retry: { nextAttempt: 1, claim: retryClaim("9000000") },
      reroute: { model: null, substrate: null },
      escalation: null,
    });
    expect(selection.kind).toBe("fail-closed");
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.inadmissibleCode).toBe("budget-ceiling");
  });

  test("D6c policy-forbidden re-route routes are not selectable through this plane", () => {
    // A hard policy restriction denying rail-b: the model-economics
    // selection (whose admissibility consumes the restriction) selects
    // nothing admissible; the re-route candidate is inadmissible with
    // the typed no-alternative reason — the recovery plane CANNOT
    // route around policy by re-implementing economics.
    const withPolicy: OptimizationConstraint[] = [
      ...constraints(),
      {
        constraintId: "policy-route-restriction",
        kind: "policy",
        enforcement: "hard",
        source: { authority: "policy", policySetId: "ps-1" },
        payload: { providerModel: { deniedProviders: ["rail-b"] } },
      },
    ];
    const selection = selectWith(infraAttribution(), {
      retry: null,
      reroute: {
        model: {
          selection: modelReroute(withPolicy),
          declaredCandidates: [
            {
              candidateId: "rail-b-model-y",
              route: { provider: "rail-b", model: "model-y" },
              representationClass: "sufficient-model" as const,
              claim: {
                expectedCostMicroUsd: "300",
                expectedLatencyMs: 1800,
                expectedQuality: 0.9,
                expectedReliability: 0.95,
                basis: { basis: "estimated" as const, source: "model-economics:route-table" },
              },
            },
          ],
        },
        substrate: null,
      },
      escalation: null,
    });
    const modelVerdict = selection.verdicts.find((v) => v.candidateId === "reroute-model");
    expect(modelVerdict?.admissible).toBe(false);
    expect(modelVerdict?.inadmissibleCode).toBe("no-alternative-route");
    expect(selection.kind).toBe("fail-closed");
  });

  test("D6d the decision record never authorizes: evidence-only shape (serialized scan)", () => {
    const selection = selectWith(infraAttribution(), fullFacts());
    const ir = governedIr();
    const record = buildRecoveryDecisionRecord({
      attribution: infraAttribution(),
      selection,
      claims: new Map<string, CostClaim>([
        ["retry-attempt-1", retryClaim()],
        [
          "reroute-model",
          {
            expectedCostMicroUsd: "300",
            expectedLatencyMs: 1800,
            expectedQuality: 0.9,
            expectedReliability: 0.95,
            basis: { basis: "estimated", source: "model-economics" },
          },
        ],
        [
          "reroute-substrate",
          {
            expectedCostMicroUsd: "242",
            expectedLatencyMs: 2000,
            expectedQuality: 0.88,
            expectedReliability: 0.93,
            basis: { basis: "observed", source: "substrate-economics" },
          },
        ],
      ]),
      ir,
      constraints: constraints(),
      scope: {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        recordedAt: "2026-09-23T09:00:00.000Z",
      },
      digest,
    });
    expect(record).not.toBeNull();
    const serialized = JSON.stringify(record);
    // No permission semantics ride the record.
    for (const forbidden of ["authorize", "admission", "approved", "permission", "allowed"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
    // The attribution provenance rides the evidence (detail).
    expect(record?.transformationBasis.detail).toContain("attribution=");
  });

  test("D6e the escalation hook consumes — never re-decides — the fresh-escalation economics", () => {
    // An escalation claim whose justification hook said NO is
    // inadmissible (escalation-not-justified): the model-economics
    // decision IS the authority on escalation justification, consumed
    // read-only here.
    const decision = decideFreshEscalation({
      continuation: {
        expectedCostMicroUsd: "400",
        expectedLatencyMs: 5000,
        expectedQuality: 0.9,
        expectedReliability: 0.9,
        basis: { basis: "estimated", source: "recovery:continuation" },
      },
      freshContext: {
        expectedCostMicroUsd: "600",
        expectedLatencyMs: 5200,
        expectedQuality: 0.92,
        expectedReliability: 0.94,
        basis: { basis: "estimated", source: "recovery:fresh" },
      },
      qualityFacts: { requiredQuality: 0.85 },
      constraints: constraints(),
    });
    expect(decision.kind).toBe("continue-current-context");
    const selection = selectWith(infraAttribution(), {
      retry: null,
      reroute: { model: null, substrate: null },
      escalation: {
        decision,
        claim: {
          expectedCostMicroUsd: "600",
          expectedLatencyMs: 5200,
          expectedQuality: 0.92,
          expectedReliability: 0.94,
          basis: { basis: "estimated", source: "recovery:fresh" },
        },
      },
    });
    const escalationVerdict = selection.verdicts.find((v) => v.candidateId === "escalate-fresh");
    expect(escalationVerdict?.admissible).toBe(false);
    expect(escalationVerdict?.inadmissibleCode).toBe("escalation-not-justified");
    expect(selection.kind).toBe("fail-closed");
  });
});
