/**
 * Recovery decision-record unit suite (WORK-055): the WORK-049 record
 * ride — the selected strategy as an `OptimizationDecisionRecord`
 * through the foundation's own builder, the identity basis for retry,
 * the substitution basis for re-route/escalation, the no-record
 * discipline for the fail-closed outcome, and deterministic
 * re-recording.
 */

import { describe, expect, test } from "vitest";
import { validateOptimizationDecision } from "../../../../src/platform/execution-ir/decision-record";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import { buildRecoveryDecisionRecord } from "../../../../src/platform/failure-recovery/decisions";
import type { RecoveryFacts } from "../../../../src/platform/failure-recovery/strategy";
import { selectRecoveryStrategy } from "../../../../src/platform/failure-recovery/strategy";
import {
  APPLICATION_ID,
  claim,
  constraints,
  digest,
  EXECUTION_ID,
  freshEscalationDecision,
  governedIr,
  infraAttribution,
  intelligenceAttribution,
  modelRerouteFacts,
  substrateRerouteFacts,
  TENANT_ID,
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

function claimsOf(facts: RecoveryFacts): Map<string, ReturnType<typeof claim>> {
  const claims = new Map<string, ReturnType<typeof claim>>();
  if (facts.retry) {
    claims.set(`retry-attempt-${facts.retry.nextAttempt}`, facts.retry.claim);
  }
  if (facts.reroute.model?.selection.selected) {
    const selected = facts.reroute.model.selection.selected;
    const declared = facts.reroute.model.declaredCandidates.find(
      (candidate) => candidate.candidateId === selected.candidateId,
    );
    if (declared) {
      claims.set("reroute-model", {
        expectedCostMicroUsd: selected.evaluation.expectedSuccessfulResolutionCostMicroUsd,
        expectedLatencyMs: declared.claim.expectedLatencyMs,
        expectedQuality: declared.claim.expectedQuality,
        expectedReliability: declared.claim.expectedReliability,
        basis: {
          basis: declared.claim.basis.basis,
          source: `model-economics;route=${selected.route.provider}/${selected.route.model}`,
        },
      });
    }
  }
  if (facts.reroute.substrate?.selection.selected) {
    const selected = facts.reroute.substrate.selection.selected;
    claims.set("reroute-substrate", {
      expectedCostMicroUsd: selected.economics.expectedSuccessfulResolutionCostMicroUsd,
      expectedLatencyMs: selected.economics.totalLatencyMs,
      expectedQuality: selected.economics.execution.expectedQuality,
      expectedReliability: selected.economics.execution.expectedReliability,
      basis: { basis: "observed", source: "substrate-economics" },
    });
  }
  if (facts.escalation) {
    claims.set("escalate-fresh", facts.escalation.claim);
  }
  return claims;
}

function selectAndRecord(
  attribution: Parameters<typeof selectRecoveryStrategy>[0]["attribution"],
  facts: RecoveryFacts,
) {
  const ir = governedIr();
  const selection = selectRecoveryStrategy({
    attribution,
    context: { attemptsUsed: 0, incumbentRoute: { provider: "rail-a", model: "model-x" } },
    facts,
    qualityFacts: { requiredQuality: 0.85 },
    constraints: constraints(),
    configuration: CONFIGURATION,
    digest,
  });
  const record = buildRecoveryDecisionRecord({
    attribution,
    selection,
    claims: claimsOf(facts),
    ir,
    constraints: constraints(),
    scope: {
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      executionId: EXECUTION_ID,
      recordedAt: "2026-09-23T09:00:00.000Z",
    },
    digest,
  });
  return { selection, record, ir };
}

describe("recovery decision records (WORK-055)", () => {
  test("a selected re-route strategy becomes a WORK-049 record with the substitution basis", () => {
    const { selection, record } = selectAndRecord(infraAttribution(), factsOf());
    expect(selection.kind).toBe("recover");
    expect(record).not.toBeNull();
    expect(record?.selectedCandidateId).toBe("reroute-substrate");
    expect(record?.transformationBasis.code).toBe("representation-substitution");
    expect(record?.transformationBasis.detail).toContain("failure-recovery");
    expect(record?.transformationBasis.detail).toContain("attribution=");
    expect(record?.transformationBasis.detail).toContain("class=infrastructure");
    // The corpus carries every claim-bearing verdict (admissible and
    // discipline-rejected alike — the comparison evidence).
    expect(record?.candidates.length).toBeGreaterThanOrEqual(2);
    // The foundation's own validation passes at read time.
    expect(() => validateOptimizationDecision(record, digest)).not.toThrow();
    // The provenance chain rides the foundation.
    expect(record?.provenance.recordedVia).toBe("execution-ir-foundation");
    expect(record?.planId).toBe(governedIr().planId);
  });

  test("a selected retry strategy records with the IDENTITY basis (same representation)", () => {
    const { record } = selectAndRecord(
      infraAttribution(),
      factsOf({ reroute: { model: null, substrate: null }, escalation: null }),
    );
    expect(record?.selectedCandidateId).toBe("retry-attempt-1");
    expect(record?.transformationBasis.code).toBe("identity");
  });

  test("a fail-closed selection produces NO record (the typed outcome IS the evidence)", () => {
    const { selection, record } = selectAndRecord(
      infraAttribution(),
      factsOf({ retry: null, reroute: { model: null, substrate: null }, escalation: null }),
    );
    expect(selection.kind).toBe("fail-closed");
    expect(record).toBeNull();
  });

  test("deterministic re-recording: identical inputs → identical decisionId", () => {
    const first = selectAndRecord(infraAttribution(), factsOf());
    const second = selectAndRecord(infraAttribution(), factsOf());
    expect(first.record?.decisionId).toBe(second.record?.decisionId);
    expect(first.record?.recordDigest).toBe(second.record?.recordDigest);
  });

  test("the intelligence-failure recovery records the re-route substitution with class evidence", () => {
    const { selection, record } = selectAndRecord(intelligenceAttribution(), factsOf());
    expect(selection.selected?.strategy).toBe("re-route");
    expect(record?.transformationBasis.detail).toContain("class=intelligence");
    expect(record?.transformationBasis.detail).toContain("signal=verification-failed");
    expect(record?.transformationBasis.code).toBe("representation-substitution");
  });

  test("an evaluated verdict without its claim fails closed (corpus coherence)", () => {
    const ir = governedIr();
    const selection = selectRecoveryStrategy({
      attribution: infraAttribution(),
      context: { attemptsUsed: 0, incumbentRoute: { provider: "rail-a", model: "model-x" } },
      facts: factsOf(),
      qualityFacts: { requiredQuality: 0.85 },
      constraints: constraints(),
      configuration: CONFIGURATION,
      digest,
    });
    expect(() =>
      buildRecoveryDecisionRecord({
        attribution: infraAttribution(),
        selection,
        claims: new Map(),
        ir,
        constraints: constraints(),
        scope: {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          recordedAt: "2026-09-23T09:00:00.000Z",
        },
        digest,
      }),
    ).toThrowError(FailureRecoveryError);
  });

  test("an empty constraint set fails closed (unprovenanced decision)", () => {
    const ir = governedIr();
    const selection = selectRecoveryStrategy({
      attribution: infraAttribution(),
      context: { attemptsUsed: 0, incumbentRoute: { provider: "rail-a", model: "model-x" } },
      facts: factsOf({ reroute: { model: null, substrate: null }, escalation: null }),
      qualityFacts: { requiredQuality: 0.85 },
      constraints: constraints(),
      configuration: CONFIGURATION,
      digest,
    });
    expect(() =>
      buildRecoveryDecisionRecord({
        attribution: infraAttribution(),
        selection,
        claims: claimsOf(factsOf({ reroute: { model: null, substrate: null }, escalation: null })),
        ir,
        constraints: [],
        scope: {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          recordedAt: "2026-09-23T09:00:00.000Z",
        },
        digest,
      }),
    ).toThrowError(/governing constraints/);
  });

  test("the selected candidate must be present in the corpus (selection coherence)", () => {
    const ir = governedIr();
    const facts = factsOf();
    const selection = selectRecoveryStrategy({
      attribution: infraAttribution(),
      context: { attemptsUsed: 0, incumbentRoute: { provider: "rail-a", model: "model-x" } },
      facts,
      qualityFacts: { requiredQuality: 0.85 },
      constraints: constraints(),
      configuration: CONFIGURATION,
      digest,
    });
    // Drop the selected candidate's claim from the corpus: the record
    // is rejected before it exists.
    const claims = claimsOf(facts);
    claims.delete("reroute-substrate");
    expect(() =>
      buildRecoveryDecisionRecord({
        attribution: infraAttribution(),
        selection,
        claims,
        ir,
        constraints: constraints(),
        scope: {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          recordedAt: "2026-09-23T09:00:00.000Z",
        },
        digest,
      }),
    ).toThrowError(FailureRecoveryError);
  });
});
