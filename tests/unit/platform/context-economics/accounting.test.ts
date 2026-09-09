/**
 * Duplication accounting tests (WORK-052 AC 6): reuse/coalescing
 * outcomes are recorded as decision records through the EXISTING
 * WORK-049 evidence contract (buildOptimizationDecision) — with the
 * governing constraints, both candidates' bounded attributed claims,
 * the deterministic selection and the outcome provenance detail;
 * unattributed claims and below-threshold reuse selections are
 * rejected BEFORE the record exists; records are deterministic and
 * content-addressed.
 */

import { describe, expect, test } from "vitest";
import {
  assertRecordableOutcome,
  buildCoalescedAccountingRecord,
  buildDuplicationAccountingRecord,
} from "../../../../src/platform/context-economics/accounting";
import { ContextEconomicsError } from "../../../../src/platform/context-economics/catalog";
import { deriveTenantScopedCacheKey } from "../../../../src/platform/context-economics/keys";
import { readMemoizationHooks } from "../../../../src/platform/context-economics/memo";
import {
  DecisionValidationError,
  validateOptimizationDecision,
} from "../../../../src/platform/execution-ir/decision-record";
import {
  APPLICATION_ID,
  compiledVariant,
  constraints,
  EXECUTION_ID,
  governedIr,
  nodeDigest,
  permissivePolicy,
  SCOPE,
  TENANT_ID,
} from "./helpers";

const RECORDED_AT = "2026-09-22T12:00:00.000Z";

function economics() {
  return {
    freshExecution: {
      expectedCostMicroUsd: "500000",
      expectedLatencyMs: 2000,
      expectedQuality: 0.95,
      expectedReliability: 0.9,
      basis: { basis: "estimated" as const, source: "planning.route-table" },
    },
    avoidedExecution: {
      expectedCostMicroUsd: "1000",
      expectedLatencyMs: 50,
      expectedQuality: 0.95,
      expectedReliability: 1,
      basis: { basis: "observed" as const, source: "context-economics.cache-observer" },
    },
  };
}

describe("duplication accounting", () => {
  test("a cache-reuse outcome builds a valid WORK-049 decision record", () => {
    const ir = governedIr();
    const variant = compiledVariant(ir);
    const hook = readMemoizationHooks(variant).hooks[0];
    expect(hook).toBeDefined();
    const cacheKey = deriveTenantScopedCacheKey(
      SCOPE,
      "memo-entry",
      { variantIrId: variant.variantIrId, memoKey: hook?.memoKey },
      nodeDigest,
    );
    const record = buildDuplicationAccountingRecord(
      {
        ir,
        constraints: constraints(),
        scope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID, executionId: EXECUTION_ID },
        outcome: {
          kind: "cache-reuse",
          cacheKey: cacheKey.key,
          contentDigest: "a".repeat(64),
          memoKey: hook?.memoKey ?? "",
        },
        economics: economics(),
        qualityThreshold: 0.8,
        recordedAt: RECORDED_AT,
      },
      nodeDigest,
    );
    // The record is a fully valid WORK-049 decision (round-trips).
    expect(() => validateOptimizationDecision(record, nodeDigest)).not.toThrow();
    expect(record.selectedCandidateId).toBe("reused-memo-entry");
    expect(record.selectedExpectation.representationClass).toBe("cache-reuse");
    expect(record.selectedExpectation.expectedCostMicroUsd).toBe("1000");
    expect(record.transformationBasis.code).toBe("representation-substitution");
    expect(record.transformationBasis.detail).toContain("duplication-accounting:cache-reuse");
    expect(record.transformationBasis.detail).toContain(cacheKey.key);
    expect(record.irId).toBe(ir.irId);
    expect(record.planId).toBe(ir.planId);
    // Both candidates are recorded with their bases (the evidence
    // contract: input constraints → candidates → selection).
    expect(record.candidates.map((candidate) => candidate.candidateId).sort()).toEqual([
      "fresh-execution",
      "reused-memo-entry",
    ]);
    expect(record.constraints.length).toBeGreaterThanOrEqual(2);
  });

  test("coalesced outcomes record per role (leader vs joiner)", () => {
    const ir = governedIr();
    const equivalenceKey = deriveTenantScopedCacheKey(
      SCOPE,
      "coalesce-group",
      { kind: "summarize", input: "artifact-9" },
      nodeDigest,
    );
    const base = {
      ir,
      constraints: constraints(),
      scope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
      economics: economics(),
      qualityThreshold: 0.8,
      recordedAt: RECORDED_AT,
    };
    const leaderRecord = buildCoalescedAccountingRecord(
      {
        ...base,
        role: "leader",
        leaderExecutionId: EXECUTION_ID,
        equivalenceKey: equivalenceKey.key,
        joinerCount: 3,
      },
      nodeDigest,
    );
    const joinerRecord = buildCoalescedAccountingRecord(
      {
        ...base,
        role: "joiner",
        leaderExecutionId: EXECUTION_ID,
        equivalenceKey: equivalenceKey.key,
        joinerCount: 3,
      },
      nodeDigest,
    );
    expect(leaderRecord.selectedCandidateId).toBe("coalesce-led-execution");
    expect(leaderRecord.transformationBasis.detail).toContain("coalesce-led");
    expect(leaderRecord.transformationBasis.detail).toContain("joinerCount=3");
    expect(joinerRecord.selectedCandidateId).toBe("coalesced-join");
    expect(joinerRecord.transformationBasis.detail).toContain("coalesced-join");
    expect(joinerRecord.transformationBasis.detail).toContain("leaderExecutionId=");
    // Different outcomes are different records (different identities).
    expect(leaderRecord.decisionId).not.toBe(joinerRecord.decisionId);
    // Both round-trip validation.
    expect(() => validateOptimizationDecision(leaderRecord, nodeDigest)).not.toThrow();
    expect(() => validateOptimizationDecision(joinerRecord, nodeDigest)).not.toThrow();
  });

  test("UNATTRIBUTED claims are rejected BEFORE the record exists", () => {
    const ir = governedIr();
    expect(() =>
      buildDuplicationAccountingRecord(
        {
          ir,
          constraints: constraints(),
          scope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
          outcome: {
            kind: "cache-reuse",
            cacheKey: "a".repeat(64),
            contentDigest: "b".repeat(64),
            memoKey: "c".repeat(64),
          },
          economics: {
            freshExecution: { ...economics().freshExecution, basis: undefined as never },
            avoidedExecution: economics().avoidedExecution,
          },
          qualityThreshold: 0.8,
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      ),
    ).toThrow();
  });

  test("UNBOUNDED claims are rejected BEFORE the record exists", () => {
    const ir = governedIr();
    expect(() =>
      buildDuplicationAccountingRecord(
        {
          ir,
          constraints: constraints(),
          scope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
          outcome: {
            kind: "cache-reuse",
            cacheKey: "a".repeat(64),
            contentDigest: "b".repeat(64),
            memoKey: "c".repeat(64),
          },
          economics: {
            freshExecution: {
              ...economics().freshExecution,
              expectedCostMicroUsd: "9999999999999999999999",
            },
            avoidedExecution: economics().avoidedExecution,
          },
          qualityThreshold: 0.8,
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      ),
    ).toThrow();
  });

  test("a below-threshold reuse selection is rejected (quality-preserving economics)", () => {
    const ir = governedIr();
    // The reused claim's quality (0.5) is below the threshold (0.8):
    // recording such a reuse would be a dishonest below-threshold
    // selection — the foundation rejects it before the record exists.
    expect(() =>
      buildDuplicationAccountingRecord(
        {
          ir,
          constraints: constraints(),
          scope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
          outcome: {
            kind: "cache-reuse",
            cacheKey: "a".repeat(64),
            contentDigest: "b".repeat(64),
            memoKey: "c".repeat(64),
          },
          economics: {
            freshExecution: economics().freshExecution,
            avoidedExecution: { ...economics().avoidedExecution, expectedQuality: 0.5 },
          },
          qualityThreshold: 0.8,
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      ),
    ).toThrow(DecisionValidationError);
  });

  test("DETERMINISM: identical accounting inputs produce the identical record", () => {
    const ir = governedIr();
    const input = {
      ir,
      constraints: constraints(),
      scope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID, executionId: EXECUTION_ID },
      outcome: {
        kind: "prefix-reuse" as const,
        prefixKey: "d".repeat(64),
        prefixSegments: 2,
        prefixTokens: 1500,
      },
      economics: economics(),
      qualityThreshold: 0.8,
      recordedAt: RECORDED_AT,
    };
    const first = buildDuplicationAccountingRecord(input, nodeDigest);
    const second = buildDuplicationAccountingRecord(input, nodeDigest);
    expect(first).toEqual(second);
    expect(first.decisionId).toBe(second.decisionId);
    expect(first.recordDigest).toBe(second.recordDigest);
  });

  test("the policy facts are irrelevant to accounting (evidence, not authority)", () => {
    // Sanity: accounting consumes constraints + claims; a permissive
    // policy fact set is not an accounting input at all (the record
    // never encodes permissions).
    const ir = governedIr();
    const record = buildDuplicationAccountingRecord(
      {
        ir,
        constraints: constraints(),
        scope: { applicationId: APPLICATION_ID, tenantId: TENANT_ID },
        outcome: {
          kind: "coalesced-join",
          leaderExecutionId: EXECUTION_ID,
          equivalenceKey: "e".repeat(64),
        },
        economics: economics(),
        qualityThreshold: 0.8,
        recordedAt: RECORDED_AT,
      },
      nodeDigest,
    );
    expect(JSON.stringify(record)).not.toContain("reuseAllowed");
    expect(JSON.stringify(record)).not.toContain("permissive");
    void permissivePolicy;
  });

  test("the recordable-outcome assertion fails closed on malformed outcomes", () => {
    // A cache-reuse outcome without a digest content is rejected.
    expect(() =>
      assertRecordableOutcome({
        kind: "cache-reuse",
        cacheKey: "a".repeat(64),
        contentDigest: "not-a-digest",
        memoKey: "c".repeat(64),
      }),
    ).toThrow(ContextEconomicsError);
    // A coalesced-join outcome without a leader identity is rejected.
    expect(() =>
      assertRecordableOutcome({
        kind: "coalesced-join",
        leaderExecutionId: "",
        equivalenceKey: "e".repeat(64),
      }),
    ).toThrow(ContextEconomicsError);
    // Well-formed outcomes pass.
    expect(() =>
      assertRecordableOutcome({
        kind: "coalesce-led",
        joinerCount: 2,
        equivalenceKey: "e".repeat(64),
      }),
    ).not.toThrow();
  });
});
