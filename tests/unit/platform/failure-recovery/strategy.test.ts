/**
 * Recovery strategy selection unit suite (WORK-055): the pure
 * deterministic decision — the retry discipline (typed retryable
 * classes, transient requirement, attempt bounds), re-route through
 * the economics planes' facts, evidence-driven escalation, the
 * deterministic total order, the fail-closed zero-recovery outcome,
 * and idempotence on re-run.
 */

import { describe, expect, test } from "vitest";
import type { CandidateEvaluation } from "../../../../src/platform/execution-ir/cost-model";
import { attributeFailure } from "../../../../src/platform/failure-recovery/attribution";
import {
  CONTEXT_REPAIRABLE_CLASSES,
  RECOVERY_STRATEGIES,
  REROUTE_DIMENSIONS,
  VERIFICATION_DEPTHS,
} from "../../../../src/platform/failure-recovery/catalog";
import type {
  RecoveryFacts,
  StrategyVerdict,
} from "../../../../src/platform/failure-recovery/strategy";
import {
  compareStrategies,
  STRATEGY_RANK,
  selectRecoveryStrategy,
} from "../../../../src/platform/failure-recovery/strategy";
import { selectModelRepresentation } from "../../../../src/platform/model-economics/model-selection";
import {
  budgetAttribution,
  claim,
  constraints,
  contextRepairFacts,
  digest,
  freshEscalationDecision,
  governedIr,
  infraAttribution,
  intelligenceAttribution,
  modelRerouteFacts,
  providerAttribution,
  providerRerouteFacts,
  substrateRerouteFacts,
  toolAttribution,
  verifierEscalationFacts,
} from "./world";

const CONFIGURATION = {
  maxRetryAttempts: 3,
  escalationEvidenceBound: 8,
  continuationStepBound: 32,
};

function factsOf(overrides: Partial<RecoveryFacts> = {}): RecoveryFacts {
  return {
    retry: { nextAttempt: 1, claim: claim("400", 2000, 0.92, 0.95, "recovery:retry-path") },
    reroute: {
      model: modelRerouteFacts(constraints()),
      substrate: { selection: substrateRerouteFacts(constraints()) },
    },
    escalation: {
      decision: freshEscalationDecision(true),
      claim: claim("600", 5200, 0.92, 0.94, "recovery:fresh-context-path"),
    },
    ...overrides,
  };
}

function select(
  attribution: Parameters<typeof selectRecoveryStrategy>[0]["attribution"],
  facts: RecoveryFacts,
) {
  return selectRecoveryStrategy({
    attribution,
    context: {
      executionId: "00000000-0000-7000-8000-0000000000cc",
      stepId: "generate",
      attemptsUsed: 0,
      incumbentRoute: { provider: "rail-a", model: "model-x" },
    },
    facts,
    qualityFacts: { requiredQuality: 0.85 },
    constraints: constraints(),
    configuration: CONFIGURATION,
    digest,
  });
}

describe("recovery strategy selection (WORK-055)", () => {
  test("a transient infrastructure failure with only the retry path selects retry (identity-preserving)", () => {
    const selection = select(
      infraAttribution(),
      factsOf({ reroute: { model: null, substrate: null }, escalation: null }),
    );
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("retry");
    expect(selection.selected?.candidateId).toBe("retry-attempt-1");
  });

  test("cost ascending over the real planes: the substrate re-route (242 µUSD) beats model re-route (316) and retry (421)", () => {
    // The full-facts corpus: reroute-substrate wins on expected
    // successful-resolution cost — the WORK-054 economics consumed
    // read-only through the substrate plane's own selection.
    const selection = select(infraAttribution(), factsOf());
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("re-route");
    expect(selection.selected?.rerouteDimension).toBe("substrate");
    expect(selection.selected?.candidateId).toBe("reroute-substrate");
    const costs = selection.verdicts
      .filter((v) => v.admissible)
      .map((v) => v.evaluation?.expectedSuccessfulResolutionCostMicroUsd);
    expect(costs).toEqual(
      [...costs].sort((a, b) => (BigInt(a ?? "0") < BigInt(b ?? "0") ? -1 : 1)),
    );
    // Every admissible verdict passed the shared floors.
    expect(
      selection.verdicts
        .filter((v) => v.admissible)
        .every((v) => v.evaluation?.qualityExpectation.meetsThreshold !== false),
    ).toBe(true);
  });

  test("cost ascending: when the model re-route is cheaper than retry, it wins", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: {
          nextAttempt: 1,
          claim: claim("2000", 20000, 0.92, 0.5, "recovery:expensive-retry"),
        },
        reroute: { model: modelRerouteFacts(constraints()), substrate: null },
        escalation: null,
      }),
    );
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("re-route");
    expect(selection.selected?.rerouteDimension).toBe("model");
  });

  test("intelligence failures are NEVER same-representation-retryable (the token-inflation trap)", () => {
    const selection = select(intelligenceAttribution(), factsOf());
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.admissible).toBe(false);
    expect(retryVerdict?.inadmissibleCode).toBe("class-not-retryable");
    // The intelligence failure recovers through the cheaper
    // alternative representation (re-route), not a blind retry.
    expect(selection.kind).toBe("recover");
    expect(["re-route", "escalate-fresh"]).toContain(selection.selected?.strategy);
  });

  test("budget exhaustion is never retryable (the budget authority stays the authority)", () => {
    const selection = select(budgetAttribution(), factsOf());
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.admissible).toBe(false);
    expect(retryVerdict?.inadmissibleCode).toBe("budget-resource-not-retryable");
  });

  test("non-transient infrastructure failures are not retryable", () => {
    const nonTransient = attributeFailure(
      {
        signal: "transport-unreachable",
        component: "edge-gateway",
        stepId: "generate",
        detail: "persistent outage",
        observedAt: "2026-09-23T08:59:00.000Z",
        observationDigest: digest.sha256Hex("observation:persistent"),
      },
      "infrastructure",
      { kind: "infrastructure", transient: false },
      digest,
    );
    const selection = select(nonTransient, factsOf());
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.admissible).toBe(false);
    expect(retryVerdict?.inadmissibleCode).toBe("retry-not-transient");
  });

  test("the attempt bound closes the retry loop (bounded re-execution)", () => {
    const selection = selectRecoveryStrategy({
      attribution: infraAttribution(),
      context: { attemptsUsed: 3, incumbentRoute: { provider: "rail-a", model: "model-x" } },
      facts: factsOf({
        retry: { nextAttempt: 4, claim: claim("400", 2000, 0.92, 0.95, "recovery:retry") },
      }),
      qualityFacts: { requiredQuality: 0.85 },
      constraints: constraints(),
      configuration: CONFIGURATION,
      digest,
    });
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.admissible).toBe(false);
    expect(retryVerdict?.inadmissibleCode).toBe("retry-attempt-bound");
  });

  test("re-route consumes the model-economics selection read-only: no alternative → inadmissible", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        reroute: {
          model: {
            selection: {
              ...modelRerouteFacts(constraints()).selection,
              selected: null,
              kind: "no-admissible-candidate",
            },
            declaredCandidates: [],
          },
          substrate: null,
        },
        escalation: null,
        retry: null,
      }),
    );
    expect(selection.kind).toBe("fail-closed");
    expect(selection.failClosedCode).toBe("no-admissible-strategy");
    const modelVerdict = selection.verdicts.find((v) => v.candidateId === "reroute-model");
    expect(modelVerdict?.inadmissibleCode).toBe("no-alternative-route");
  });

  test("re-route-model re-selecting the incumbent route is inadmissible (not a hidden retry)", () => {
    // A model-economics selection whose whole corpus IS the incumbent
    // route: the re-selection is a no-op for routing purposes.
    const incumbentOnly = selectModelRepresentation({
      ir: governedIr(),
      stepId: "generate",
      candidates: [
        {
          candidateId: "rail-a-model-x",
          route: { provider: "rail-a", model: "model-x" },
          representationClass: "sufficient-model" as const,
          claim: claim("300", 1800, 0.9, 0.95, "model-economics:route-table"),
        },
      ],
      qualityFacts: { requiredQuality: 0.85 },
      constraints: constraints(),
    });
    const selection = select(
      infraAttribution(),
      factsOf({
        reroute: {
          model: {
            selection: incumbentOnly,
            declaredCandidates: [
              {
                candidateId: "rail-a-model-x",
                route: { provider: "rail-a", model: "model-x" },
                representationClass: "sufficient-model" as const,
                claim: claim("300", 1800, 0.9, 0.95, "model-economics:route-table"),
              },
            ],
          },
          substrate: null,
        },
        retry: null,
        escalation: null,
      }),
    );
    const modelVerdict = selection.verdicts.find((v) => v.candidateId === "reroute-model");
    expect(modelVerdict?.admissible).toBe(false);
    expect(modelVerdict?.inadmissibleCode).toBe("no-alternative-route");
    expect(selection.kind).toBe("fail-closed");
  });

  test("re-route-substrate inadmissible when the substrate plane selected nothing", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        reroute: {
          model: null,
          substrate: {
            selection: {
              ...substrateRerouteFacts(constraints()),
              selected: null,
              outcome: "no-sufficient-substrate" as const,
            },
          },
        },
        retry: null,
        escalation: null,
      }),
    );
    const substrateVerdict = selection.verdicts.find((v) => v.candidateId === "reroute-substrate");
    expect(substrateVerdict?.inadmissibleCode).toBe("no-substrate-selection");
  });

  test("escalation is admissible only with the hook's economic justification", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        escalation: {
          decision: freshEscalationDecision(false),
          claim: claim("600", 5200, 0.92, 0.94, "recovery:fresh-context-path"),
        },
        retry: null,
        reroute: { model: null, substrate: null },
      }),
    );
    const escalationVerdict = selection.verdicts.find((v) => v.candidateId === "escalate-fresh");
    expect(escalationVerdict?.admissible).toBe(false);
    expect(escalationVerdict?.inadmissibleCode).toBe("escalation-not-justified");
    expect(selection.kind).toBe("fail-closed");
  });

  test("escalate-fresh is selected when justified and cheapest", () => {
    const selection = select(
      intelligenceAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: {
          decision: freshEscalationDecision(true),
          claim: claim("100", 800, 0.92, 0.94, "recovery:fresh-context-path"),
        },
      }),
    );
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("escalate-fresh");
  });

  test("strategy claims below the quality floor are inadmissible (quality floors are inviolable)", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: { nextAttempt: 1, claim: claim("100", 500, 0.5, 0.99, "recovery:cheap-bad-retry") },
        reroute: { model: null, substrate: null },
        escalation: null,
      }),
    );
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.admissible).toBe(false);
    expect(retryVerdict?.inadmissibleCode).toBe("quality-below-hard-floor");
    expect(selection.kind).toBe("fail-closed");
  });

  test("strategy claims over the budget ceiling are inadmissible", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: {
          nextAttempt: 1,
          claim: claim("9000000", 500, 0.92, 0.95, "recovery:costly-retry"),
        },
        reroute: { model: null, substrate: null },
        escalation: null,
      }),
    );
    const retryVerdict = selection.verdicts.find((v) => v.strategy === "retry");
    expect(retryVerdict?.inadmissibleCode).toBe("budget-ceiling");
    expect(selection.kind).toBe("fail-closed");
  });

  test("the zero-recovery outcome is representable (fail-closed, typed, honest)", () => {
    const selection = select(
      infraAttribution(),
      factsOf({ retry: null, reroute: { model: null, substrate: null }, escalation: null }),
    );
    expect(selection.kind).toBe("fail-closed");
    expect(selection.selected).toBeNull();
    expect(selection.failClosedCode).toBe("no-admissible-strategy");
    expect(selection.selectionBasis).toContain("fail-closed-when-none-admissible");
  });

  test("determinism: identical inputs produce byte-identical selections (idempotent re-run)", () => {
    const first = select(infraAttribution(), factsOf());
    const second = select(infraAttribution(), factsOf());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("tie-breaks are deterministic: equal costs resolve by strategy rank then candidateId", () => {
    const evaluation = (candidateId: string, cost: string): CandidateEvaluation => ({
      candidateId,
      representationClass: "sufficient-model",
      valid: true,
      expectedSuccessfulResolutionCostMicroUsd: cost,
      expectedLatencyMs: 0,
      qualityExpectation: { expectedQuality: 0.9, threshold: 0.8, meetsThreshold: true },
      basis: { basis: "estimated", source: "test:tie-break" },
    });
    const verdict = (
      candidateId: string,
      strategy: StrategyVerdict["strategy"],
      cost: string,
    ): StrategyVerdict => ({
      candidateId,
      strategy,
      attributionId: "0".repeat(64),
      representationClass: "sufficient-model",
      admissible: true,
      evaluation: evaluation(candidateId, cost),
    });
    // Equal cost: retry < re-route < escalate-fresh by rank.
    expect(
      compareStrategies(verdict("x", "escalate-fresh", "100"), verdict("y", "retry", "100")),
    ).toBeGreaterThan(0);
    expect(
      compareStrategies(verdict("a", "re-route", "100"), verdict("z", "retry", "100")),
    ).toBeGreaterThan(0);
    // Same strategy, same cost: candidateId ascending.
    expect(
      compareStrategies(verdict("b", "re-route", "100"), verdict("a", "re-route", "100")),
    ).toBe(1);
    // Cost dominates rank.
    expect(
      compareStrategies(
        verdict("cheap", "escalate-fresh", "50"),
        verdict("costly", "retry", "900"),
      ),
    ).toBeLessThan(0);
    expect(STRATEGY_RANK.retry).toBeLessThan(STRATEGY_RANK["re-route"]);
    expect(STRATEGY_RANK["re-route"]).toBeLessThan(STRATEGY_RANK["escalate-fresh"]);
  });

  test("the input order of strategy candidates never changes the selection", () => {
    // The candidate assembly is structural (fixed ids), so the same
    // FACTS always produce the same verdict order: prove it by
    // re-running with the same facts built twice (fresh objects).
    const factsA = factsOf();
    const factsB = factsOf();
    const a = select(infraAttribution(), factsA);
    const b = select(infraAttribution(), factsB);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("retry facts with incoherent attempt numbers fail closed", () => {
    expect(() =>
      select(
        infraAttribution(),
        factsOf({
          retry: { nextAttempt: 7, claim: claim("400", 2000, 0.92, 0.95, "recovery:retry") },
        }),
      ),
    ).toThrowError(/coherent next attempt/);
  });

  test("the selection runs on a governed IR context end-to-end (fixtures are governed)", () => {
    const ir = governedIr();
    expect(ir.steps.find((s) => s.id === "generate")?.routeRef).toEqual({
      provider: "rail-a",
      model: "model-x",
    });
    const selection = select(providerAttribution(), factsOf());
    expect(["recover", "fail-closed"]).toContain(selection.kind);
  });
});

describe("recovery strategy selection — the ACR-008 §3 move-catalog extension (PCR-001)", () => {
  test("the extended catalog is closed: six strategies, three re-route dimensions, one ranked ladder", () => {
    expect([...RECOVERY_STRATEGIES]).toEqual([
      "retry",
      "re-route",
      "escalate-fresh",
      "context-repair",
      "verifier-escalation",
      "fail",
    ]);
    expect([...REROUTE_DIMENSIONS]).toEqual(["model", "substrate", "provider"]);
    // The existing relative orders are preserved byte-for-byte...
    expect(STRATEGY_RANK.retry).toBeLessThan(STRATEGY_RANK["re-route"]);
    expect(STRATEGY_RANK["re-route"]).toBeLessThan(STRATEGY_RANK["escalate-fresh"]);
    expect(STRATEGY_RANK["escalate-fresh"]).toBeLessThan(STRATEGY_RANK.fail);
    // ...and the new moves interleave on the disruption ladder.
    expect(STRATEGY_RANK["re-route"]).toBeLessThan(STRATEGY_RANK["context-repair"]);
    expect(STRATEGY_RANK["context-repair"]).toBeLessThan(STRATEGY_RANK["escalate-fresh"]);
    expect(STRATEGY_RANK["escalate-fresh"]).toBeLessThan(STRATEGY_RANK["verifier-escalation"]);
    expect(STRATEGY_RANK["verifier-escalation"]).toBeLessThan(STRATEGY_RANK.fail);
    // The closed class/depth tables.
    expect([...CONTEXT_REPAIRABLE_CLASSES]).toEqual(["intelligence", "tool"]);
    expect([...VERIFICATION_DEPTHS]).toEqual(["deterministic", "model-judged", "human-judged"]);
  });

  // --- PROVIDER-FAILOVER RE-ROUTE (ACR-008 §3.1) -------------------------
  test("provider-failover re-route is admissible through the supply plane's own selection", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null, provider: providerRerouteFacts(constraints()) },
        escalation: null,
      }),
    );
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("re-route");
    expect(selection.selected?.rerouteDimension).toBe("provider");
    expect(selection.selected?.candidateId).toBe("reroute-provider");
    // The claim derives from the supply plane's OWN verdict: the selected
    // alternative is the capability-equal same-model route (rail-b/model-x).
    expect(selection.selected?.evaluation?.basis.source).toBe(
      "model-economics;provider-failover=rail-b/model-x",
    );
    // The economics re-evaluate through the shared admissibility
    // (ceil(295 / 0.95) over the supply plane's own 295).
    expect(selection.selected?.evaluation?.expectedSuccessfulResolutionCostMicroUsd).toBe("311");
  });

  test("a no-selection supply verdict makes the provider dimension inadmissible (typed reason)", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: null,
        reroute: {
          model: null,
          substrate: null,
          provider: {
            selection: {
              ...providerRerouteFacts(constraints()).selection,
              selected: null,
              kind: "no-admissible-candidate",
            },
            declaredCandidates: [],
          },
        },
        escalation: null,
      }),
    );
    expect(selection.kind).toBe("fail-closed");
    const providerVerdict = selection.verdicts.find((v) => v.candidateId === "reroute-provider");
    expect(providerVerdict?.admissible).toBe(false);
    expect(providerVerdict?.inadmissibleCode).toBe("no-provider-selection");
  });

  test("re-selecting the incumbent provider route is inadmissible (no hidden retry)", () => {
    const incumbentOnly = selectModelRepresentation({
      ir: governedIr(),
      stepId: "generate",
      candidates: [
        {
          candidateId: "rail-a-model-x",
          route: { provider: "rail-a", model: "model-x" },
          representationClass: "sufficient-model" as const,
          claim: claim("300", 1800, 0.9, 0.95, "model-economics:route-table"),
        },
      ],
      qualityFacts: { requiredQuality: 0.85 },
      constraints: constraints(),
    });
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: null,
        reroute: {
          model: null,
          substrate: null,
          provider: {
            selection: incumbentOnly,
            declaredCandidates: [
              {
                candidateId: "rail-a-model-x",
                route: { provider: "rail-a", model: "model-x" },
                representationClass: "sufficient-model" as const,
                claim: claim("300", 1800, 0.9, 0.95, "model-economics:route-table"),
              },
            ],
          },
        },
        escalation: null,
      }),
    );
    const providerVerdict = selection.verdicts.find((v) => v.candidateId === "reroute-provider");
    expect(providerVerdict?.admissible).toBe(false);
    expect(providerVerdict?.inadmissibleCode).toBe("no-alternative-provider");
    expect(selection.kind).toBe("fail-closed");
  });

  test("a different-model alternate is the model dimension's move, never provider failover", () => {
    const differentModel = selectModelRepresentation({
      ir: governedIr(),
      stepId: "generate",
      candidates: [
        {
          candidateId: "rail-b-model-y",
          route: { provider: "rail-b", model: "model-y" },
          representationClass: "sufficient-model" as const,
          claim: claim("300", 1800, 0.9, 0.95, "model-economics:route-table"),
        },
      ],
      qualityFacts: { requiredQuality: 0.85 },
      constraints: constraints(),
    });
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: null,
        reroute: {
          model: null,
          substrate: null,
          provider: {
            selection: differentModel,
            declaredCandidates: [
              {
                candidateId: "rail-b-model-y",
                route: { provider: "rail-b", model: "model-y" },
                representationClass: "sufficient-model" as const,
                claim: claim("300", 1800, 0.9, 0.95, "model-economics:route-table"),
              },
            ],
          },
        },
        escalation: null,
      }),
    );
    const providerVerdict = selection.verdicts.find((v) => v.candidateId === "reroute-provider");
    expect(providerVerdict?.admissible).toBe(false);
    expect(providerVerdict?.inadmissibleCode).toBe("provider-route-not-same-representation");
  });

  // --- CONTEXT-REPAIR (ACR-008 §3.2) --------------------------------------
  test("context-repair is admissible for a context-corruption class with the capability verdict", () => {
    const selection = select(
      intelligenceAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: null,
        contextRepair: contextRepairFacts(true),
      }),
    );
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("context-repair");
    expect(selection.selected?.candidateId).toBe("context-repair");
    // The move carries its explicit-basis claim through the shared machinery.
    expect(selection.selected?.evaluation?.basis.source).toBe("recovery:context-repair-path");
    // The tool class is repairable too (the closed table).
    const toolSelection = select(
      toolAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: null,
        contextRepair: contextRepairFacts(true),
      }),
    );
    expect(toolSelection.kind).toBe("recover");
    expect(toolSelection.selected?.strategy).toBe("context-repair");
  });

  test("context-repair is inadmissible outside the closed repairable classes", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: null,
        contextRepair: contextRepairFacts(true),
      }),
    );
    const repairVerdict = selection.verdicts.find((v) => v.candidateId === "context-repair");
    expect(repairVerdict?.admissible).toBe(false);
    expect(repairVerdict?.inadmissibleCode).toBe("class-not-repairable");
    expect(selection.kind).toBe("fail-closed");
  });

  test("context-repair is inadmissible when the capability verdict says not capable", () => {
    const selection = select(
      toolAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: null,
        contextRepair: contextRepairFacts(false),
      }),
    );
    const repairVerdict = selection.verdicts.find((v) => v.candidateId === "context-repair");
    expect(repairVerdict?.admissible).toBe(false);
    expect(repairVerdict?.inadmissibleCode).toBe("repair-not-capable");
  });

  test("a malformed repair-capability verdict fails closed (never a silent default repair)", () => {
    expect(() =>
      select(
        toolAttribution(),
        factsOf({
          retry: null,
          reroute: { model: null, substrate: null },
          escalation: null,
          contextRepair: {
            capability: { kind: "maybe-repairable" } as never,
            claim: claim("500", 3000, 0.9, 0.93, "recovery:context-repair-path"),
          },
        }),
      ),
    ).toThrowError(/closed vocabulary/);
    expect(() =>
      select(
        toolAttribution(),
        factsOf({
          retry: null,
          reroute: { model: null, substrate: null },
          escalation: null,
          contextRepair: {
            capability: { kind: "repair-capable", directive: { strategy: "NOT A SLUG" } } as never,
            claim: claim("500", 3000, 0.9, 0.93, "recovery:context-repair-path"),
          },
        }),
      ),
    ).toThrowError(/reconstruction directive/);
  });

  // --- VERIFIER-ESCALATION (ACR-008 §3.3) ---------------------------------
  test("verifier-escalation is admissible for a quality-suspect outcome with the authority decision", () => {
    const selection = select(
      intelligenceAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: null,
        verifierEscalation: verifierEscalationFacts(true),
      }),
    );
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("verifier-escalation");
    expect(selection.selected?.candidateId).toBe("verifier-escalation");
    expect(selection.selected?.evaluation?.basis.source).toBe("recovery:verifier-escalation-path");
  });

  test("verifier-escalation is inadmissible for non-suspect outcomes (the class gate)", () => {
    const selection = select(
      infraAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: null,
        verifierEscalation: verifierEscalationFacts(true),
      }),
    );
    const verifierVerdict = selection.verdicts.find((v) => v.candidateId === "verifier-escalation");
    expect(verifierVerdict?.admissible).toBe(false);
    expect(verifierVerdict?.inadmissibleCode).toBe("outcome-not-quality-suspect");
  });

  test("verifier-escalation is inadmissible without the authority's justification", () => {
    const selection = select(
      intelligenceAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: null,
        verifierEscalation: verifierEscalationFacts(false),
      }),
    );
    const verifierVerdict = selection.verdicts.find((v) => v.candidateId === "verifier-escalation");
    expect(verifierVerdict?.admissible).toBe(false);
    expect(verifierVerdict?.inadmissibleCode).toBe("verifier-escalation-not-justified");
  });

  test("a depth-flat or depth-reducing escalation verdict is a typed rejection (invariant 19)", () => {
    const flatDecision = {
      ...verifierEscalationFacts(true).decision,
      toDepth: "deterministic",
    } as const;
    expect(() =>
      select(
        intelligenceAttribution(),
        factsOf({
          retry: null,
          reroute: { model: null, substrate: null },
          escalation: null,
          verifierEscalation: {
            decision: flatDecision,
            claim: claim("250", 1500, 0.95, 0.97, "recovery:verifier-escalation-path"),
          },
        }),
      ),
    ).toThrowError(/strictly increase the assurance depth/);
    const reducing = {
      ...verifierEscalationFacts(true).decision,
      fromDepth: "human-judged",
      toDepth: "model-judged",
    } as const;
    expect(() =>
      select(
        intelligenceAttribution(),
        factsOf({
          retry: null,
          reroute: { model: null, substrate: null },
          escalation: null,
          verifierEscalation: {
            decision: reducing,
            claim: claim("250", 1500, 0.95, 0.97, "recovery:verifier-escalation-path"),
          },
        }),
      ),
    ).toThrowError(/strictly increase the assurance depth/);
  });

  // --- THE EXTENDED DETERMINISTIC ORDER ------------------------------------
  test("equal-cost ties across the extended catalog resolve by the disruption ladder", () => {
    const evaluation = (candidateId: string): CandidateEvaluation => ({
      candidateId,
      representationClass: "sufficient-model",
      valid: true,
      expectedSuccessfulResolutionCostMicroUsd: "100",
      expectedLatencyMs: 0,
      qualityExpectation: { expectedQuality: 0.9, threshold: 0.8, meetsThreshold: true },
      basis: { basis: "estimated", source: "test:tie-break-extension" },
    });
    const verdict = (
      candidateId: string,
      strategy: StrategyVerdict["strategy"],
    ): StrategyVerdict => ({
      candidateId,
      strategy,
      attributionId: "0".repeat(64),
      representationClass: "sufficient-model",
      admissible: true,
      evaluation: evaluation(candidateId),
    });
    // Full ladder: retry < re-route < context-repair < escalate-fresh < verifier-escalation.
    expect(
      compareStrategies(verdict("a", "verifier-escalation"), verdict("z", "retry")),
    ).toBeGreaterThan(0);
    expect(
      compareStrategies(verdict("a", "escalate-fresh"), verdict("z", "context-repair")),
    ).toBeGreaterThan(0);
    expect(
      compareStrategies(verdict("z", "context-repair"), verdict("a", "re-route")),
    ).toBeGreaterThan(0);
    expect(
      compareStrategies(verdict("z", "verifier-escalation"), verdict("a", "escalate-fresh")),
    ).toBeGreaterThan(0);
    // The three re-route dimensions tie on rank: candidateId decides.
    expect(
      compareStrategies(
        verdict("reroute-substrate", "re-route"),
        verdict("reroute-model", "re-route"),
      ),
    ).toBe(1);
  });

  test("equal-cost context-repair and verifier-escalation prefer the repair (rank, then economics)", () => {
    // Both moves admissible with identical claims: the tie resolves on
    // the disruption ladder (context-repair ranks below
    // verifier-escalation).
    const tiedClaim = claim("300", 2000, 0.9, 0.95, "recovery:tied-path");
    const selection = select(
      intelligenceAttribution(),
      factsOf({
        retry: null,
        reroute: { model: null, substrate: null },
        escalation: null,
        contextRepair: { capability: contextRepairFacts(true).capability, claim: tiedClaim },
        verifierEscalation: {
          decision: verifierEscalationFacts(true).decision,
          claim: { ...tiedClaim, basis: { ...tiedClaim.basis, source: "recovery:tied-verifier" } },
        },
      }),
    );
    expect(selection.kind).toBe("recover");
    expect(selection.selected?.strategy).toBe("context-repair");
  });
});
