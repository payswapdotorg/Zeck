/**
 * Substrate-selection accounting tests (WORK-054 AC 2 evidence ride):
 * the least-expense-sufficient selection recorded as a WORK-049
 * `OptimizationDecisionRecord` through the foundation's own
 * `buildOptimizationDecision` — with the IR's governing constraints,
 * the sufficient candidates' composite claims (expected
 * successful-resolution cost incl. startup, TOTAL latency, explicit
 * substrate-facts basis), the selected substrate/mode, and the
 * representation-substitution transformation basis; incoherent
 * provenance is rejected BEFORE the record exists.
 */

import { describe, expect, test } from "vitest";
import {
  DecisionValidationError,
  validateOptimizationDecision,
} from "../../../../src/platform/execution-ir/decision-record";
import { buildSubstrateAccountingRecord } from "../../../../src/platform/substrate-economics/accounting";
import type { SubstrateEconomicsError } from "../../../../src/platform/substrate-economics/catalog";
import {
  deriveSelectionConstraints,
  selectSubstrate,
} from "../../../../src/platform/substrate-economics/selection";
import {
  APPLICATION_ID,
  constraints,
  EXECUTION_ID,
  governedIr,
  nodeDigest,
  substrateCorpus,
  TENANT_ID,
} from "./helpers";

const RECORDED_AT = "2026-09-24T12:00:00.000Z";

function selectedResult() {
  const derived = deriveSelectionConstraints(constraints());
  return selectSubstrate(
    {
      candidates: substrateCorpus(),
      constraints: derived.constraints,
      sourceConstraintIds: derived.sourceConstraintIds,
      recordedAt: RECORDED_AT,
    },
    nodeDigest,
  );
}

describe("substrate-selection accounting", () => {
  test("a selected outcome builds a valid WORK-049 decision record", () => {
    const ir = governedIr();
    const selection = selectedResult();
    expect(selection.outcome).toBe("selected");
    expect(selection.selected?.substrateId).toBe("mid-container-b");
    const record = buildSubstrateAccountingRecord(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        executionId: EXECUTION_ID,
        ir,
        constraints: constraints(),
        selection,
        representationClass: "programmatic-execution",
        recordedAt: RECORDED_AT,
      },
      nodeDigest,
    );
    expect(record.selectedCandidateId).toBe("substrate-mid-container-b-snapshot");
    expect(record.qualityThreshold).toBe(0.8);
    expect(record.transformationBasis.code).toBe("representation-substitution");
    expect(record.transformationBasis.detail).toContain("mid-container-b@2.0.0");
    expect(record.transformationBasis.detail).toContain("mode snapshot");
    // Every SUFFICIENT candidate is recorded (mid-container-b snapshot+cold,
    // std-microvm-a warm+cold; cheap-process-c is quality-below-floor).
    expect(record.candidates.map((candidate) => candidate.candidateId).sort()).toEqual([
      "substrate-mid-container-b-cold",
      "substrate-mid-container-b-snapshot",
      "substrate-std-microvm-a-cold",
      "substrate-std-microvm-a-warm",
    ]);
    // The selected claim carries the composite economics with the
    // substrate-facts attribution.
    const selectedVerdict = record.candidates.find(
      (candidate) => candidate.candidateId === record.selectedCandidateId,
    );
    expect(selectedVerdict?.claim.expectedCostMicroUsd).toBe("242"); // ceil((25+200)/0.93)
    expect(selectedVerdict?.claim.expectedLatencyMs).toBe(3200); // 1200 + 2000
    expect(selectedVerdict?.claim.basis.source).toContain("substrate-economics:");
    expect(record.candidates.every((c) => c.claim.basis.source.length > 0)).toBe(true);
  });

  test("the record round-trips through the foundation's own validation", () => {
    const record = buildSubstrateAccountingRecord(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        ir: governedIr(),
        constraints: constraints(),
        selection: selectedResult(),
        representationClass: "programmatic-execution",
        recordedAt: RECORDED_AT,
      },
      nodeDigest,
    );
    const roundTrip = validateOptimizationDecision(JSON.parse(JSON.stringify(record)), nodeDigest);
    expect(roundTrip.decisionId).toBe(record.decisionId);
    expect(roundTrip.recordDigest).toBe(record.recordDigest);
  });

  test("the record is deterministic and content-addressed (identical inputs → identical decisionId)", () => {
    const build = () =>
      buildSubstrateAccountingRecord(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          executionId: EXECUTION_ID,
          ir: governedIr(),
          constraints: constraints(),
          selection: selectedResult(),
          representationClass: "programmatic-execution",
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      );
    const first = build();
    const second = build();
    expect(first.decisionId).toBe(second.decisionId);
    expect(first.recordDigest).toBe(second.recordDigest);
  });

  test("a NO-SELECTION outcome is rejected (a no-selection is the selection record's own evidence)", () => {
    const derived = deriveSelectionConstraints(constraints());
    const noSelection = selectSubstrate(
      {
        candidates: [],
        constraints: derived.constraints,
        sourceConstraintIds: derived.sourceConstraintIds,
        recordedAt: RECORDED_AT,
      },
      nodeDigest,
    );
    expect(noSelection.outcome).toBe("no-candidates");
    try {
      buildSubstrateAccountingRecord(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          ir: governedIr(),
          constraints: constraints(),
          selection: noSelection,
          representationClass: "programmatic-execution",
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      );
      expect.unreachable("a no-selection must not be accountable");
    } catch (error) {
      expect((error as SubstrateEconomicsError).invariant).toBe("accounting-shape");
    }
  });

  test("an incoherent selection (constraints NOT derived from the IR's set) is rejected before the record exists", () => {
    const foreign = selectSubstrate(
      {
        candidates: substrateCorpus(),
        constraints: { minQuality: 0.6 }, // NOT the derivation of constraints()
        recordedAt: RECORDED_AT,
      },
      nodeDigest,
    );
    expect(foreign.outcome).toBe("selected");
    try {
      buildSubstrateAccountingRecord(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          ir: governedIr(),
          constraints: constraints(),
          selection: foreign,
          representationClass: "programmatic-execution",
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      );
      expect.unreachable("incoherent provenance must be rejected");
    } catch (error) {
      expect((error as SubstrateEconomicsError).invariant).toBe("accounting-shape");
    }
  });

  test("an off-ladder representation class is a typed rejection", () => {
    try {
      buildSubstrateAccountingRecord(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          ir: governedIr(),
          constraints: constraints(),
          selection: selectedResult(),
          representationClass: "substrate-execution" as never,
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      );
      expect.unreachable("invented representation class must be rejected");
    } catch (error) {
      expect((error as SubstrateEconomicsError).invariant).toBe("accounting-shape");
    }
  });

  test("the foundation's own hard-constraint discipline applies wholesale (a violating IR rejects the record)", () => {
    // An IR whose steps bind capabilities OUTSIDE the satisfied set —
    // the capability-unsatisfied hard constraint fires in the
    // foundation builder BEFORE any record exists.
    const ir = governedIr(
      [
        { id: "fetch", stepClass: "retrieve", capabilityId: "unknown-capability" },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      [{ from: "fetch", to: "check" }],
    );
    expect(() =>
      buildSubstrateAccountingRecord(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          ir,
          constraints: constraints(),
          selection: selectedResult(),
          representationClass: "programmatic-execution",
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      ),
    ).toThrow(DecisionValidationError);
  });

  test("the record carries no permission vocabulary (evidence, never authorization)", () => {
    const record = buildSubstrateAccountingRecord(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        ir: governedIr(),
        constraints: constraints(),
        selection: selectedResult(),
        representationClass: "programmatic-execution",
        recordedAt: RECORDED_AT,
      },
      nodeDigest,
    );
    const serialized = JSON.stringify(record);
    for (const forbidden of ["allow", "deny", "authorize", "permission", "admission", "approve"]) {
      expect(serialized).not.toContain(`"${forbidden}`);
    }
  });

  test("a variantIrId-carrying input builds and round-trips (the foundation's verdict shape records id/class/claim/evaluation)", () => {
    const record = buildSubstrateAccountingRecord(
      {
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        ir: governedIr(),
        constraints: constraints(),
        selection: selectedResult(),
        representationClass: "programmatic-execution",
        variantIrId: "f".repeat(64),
        recordedAt: RECORDED_AT,
      },
      nodeDigest,
    );
    // The FOUNDATION's recorded verdict shape is (candidateId,
    // representationClass, claim, evaluation) — the compiled-variant
    // identity is an input-side reference; the substrate provenance
    // rides the transformation-basis detail (selectionId + factsDigest).
    expect(record.candidates.every((candidate) => candidate.claim !== undefined)).toBe(true);
    const roundTrip = validateOptimizationDecision(JSON.parse(JSON.stringify(record)), nodeDigest);
    expect(roundTrip.decisionId).toBe(record.decisionId);
  });
});
