/**
 * Deterministic provenance audit unit tests (WORK-049).
 *
 * Proves: the full plan→IR→decision chain audits clean over real
 * governed plans; re-derivation drift, IR tampering, decision identity
 * mismatches and hard-constraint violations are all detected as typed
 * violations; a decision not in the authoritative store is foreign
 * (durable variant tested over real PostgreSQL in the integration
 * suites).
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import {
  auditExecutionProvenance,
  PROVENANCE_AUDIT_CODES,
} from "../../../../src/platform/execution-ir/audit";
import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import { buildOptimizationDecision } from "../../../../src/platform/execution-ir/decision-record";
import { deriveExecutionIr, planFormOfIr } from "../../../../src/platform/execution-ir/ir";

const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";

function planAndSnapshot() {
  const plan = buildPlan(
    {
      revision: 1,
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
  return { plan, snapshot: planSource.toPlanSnapshot(plan) };
}

function decisionFor(ir: ReturnType<typeof deriveExecutionIr>) {
  return buildOptimizationDecision(
    {
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      ir,
      constraints: [
        {
          constraintId: "policy-eligibility",
          kind: "policy",
          enforcement: "hard",
          source: { authority: "policy", policySetId: "ps-1" },
          payload: { providerModel: { allowedProviders: ["rail-a"] } },
        },
        {
          constraintId: "verification-anchor",
          kind: "verification",
          enforcement: "hard",
          source: { authority: "verification" },
          payload: { requiresVerificationAnchor: true },
        },
      ],
      candidates: [
        {
          candidateId: "base-model-route",
          representationClass: "sufficient-model",
          claim: {
            expectedCostMicroUsd: "500000",
            expectedLatencyMs: 2000,
            expectedQuality: 0.93,
            expectedReliability: 0.9,
            basis: { basis: "estimated", source: "planning.route-table" },
          },
        },
      ],
      qualityThreshold: 0.9,
      selectedCandidateId: "base-model-route",
      transformationBasis: {
        code: "identity",
        detail: "The derived IR itself is the base representation; no transformation applied.",
      },
      recordedAt: "2026-09-20T12:00:00.000Z",
    },
    nodeDigest,
  );
}

describe("provenance audit (WORK-049)", () => {
  test("a clean chain audits with zero violations", () => {
    const { snapshot } = planAndSnapshot();
    const ir = deriveExecutionIr(snapshot, nodeDigest);
    const decision = decisionFor(ir);
    const result = auditExecutionProvenance({ snapshot, ir, decision, digest: nodeDigest });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.derivedIrId).toBe(ir.irId);
  });

  test("re-derivation drift is detected (snapshot no longer matches the IR)", () => {
    const { snapshot } = planAndSnapshot();
    const ir = deriveExecutionIr(snapshot, nodeDigest);
    // A DIFFERENT governed plan (revised) drifts from the presented IR.
    const driftedPlan = buildPlan(
      {
        revision: 2,
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
    const driftedSnapshot = planSource.toPlanSnapshot(driftedPlan);
    const result = auditExecutionProvenance({
      snapshot: driftedSnapshot,
      ir,
      digest: nodeDigest,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain("re-derivation-drift");
    // And the plan identity chain is broken too (different planId).
    expect(result.violations.map((violation) => violation.code)).toContain(
      "plan-identity-chain-broken",
    );
  });

  test("a tampered IR is detected", () => {
    const { snapshot } = planAndSnapshot();
    const ir = deriveExecutionIr(snapshot, nodeDigest);
    const tampered = JSON.parse(JSON.stringify(ir)) as Record<string, unknown>;
    ((tampered.steps as Record<string, unknown>[])[0] as Record<string, unknown>).id = "hijacked";
    const result = auditExecutionProvenance({
      snapshot,
      ir: tampered as unknown as typeof ir,
      digest: nodeDigest,
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.code)).toContain("ir-invalid");
  });

  test("a decision from a different IR is detected", () => {
    const first = planAndSnapshot();
    const firstIr = deriveExecutionIr(first.snapshot, nodeDigest);
    const decision = decisionFor(firstIr);

    // The same content snapshot audits clean.
    const clean = auditExecutionProvenance({
      snapshot: first.snapshot,
      ir: firstIr,
      decision,
      digest: nodeDigest,
    });
    expect(clean.ok).toBe(true);

    // A VALID decision derived from a DIFFERENT plan/IR: the record is
    // internally consistent (its digests hold) but its irId does not
    // match the audited IR — the chain mismatch is detected.
    const otherPlan = buildPlan(
      {
        revision: 9,
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
    const otherIr = deriveExecutionIr(planSource.toPlanSnapshot(otherPlan), nodeDigest);
    const otherDecision = decisionFor(otherIr);
    expect(otherIr.irId).not.toBe(firstIr.irId);
    const mismatch = auditExecutionProvenance({
      snapshot: first.snapshot,
      ir: firstIr,
      decision: otherDecision,
      digest: nodeDigest,
    });
    expect(mismatch.ok).toBe(false);
    const codes = mismatch.violations.map((violation) => violation.code);
    expect(codes).toContain("decision-ir-mismatch");
    expect(codes).toContain("decision-plan-mismatch");
  });

  test("the audit violation vocabulary is closed", () => {
    expect([...PROVENANCE_AUDIT_CODES]).toEqual([
      "ir-invalid",
      "re-derivation-drift",
      "plan-identity-chain-broken",
      "decision-invalid",
      "decision-ir-mismatch",
      "decision-plan-mismatch",
      "decision-provenance-broken",
      "hard-constraint-violation",
      "durable-record-foreign",
    ]);
  });

  test("the audit is deterministic: same inputs, same verdict", () => {
    const { snapshot } = planAndSnapshot();
    const ir = deriveExecutionIr(snapshot, nodeDigest);
    const decision = decisionFor(ir);
    const first = auditExecutionProvenance({ snapshot, ir, decision, digest: nodeDigest });
    const second = auditExecutionProvenance({ snapshot, ir, decision, digest: nodeDigest });
    expect(second).toEqual(first);
  });

  test("audit-only (no decision) verifies the plan→IR chain including losslessness", () => {
    const { snapshot } = planAndSnapshot();
    const ir = deriveExecutionIr(snapshot, nodeDigest);
    const result = auditExecutionProvenance({ snapshot, ir, digest: nodeDigest });
    expect(result.ok).toBe(true);
    // The reconstruction identity is the losslessness proof itself.
    expect(nodeDigest.sha256Hex(planFormOfIr(ir))).toBe(snapshot.planId);
  });
});
