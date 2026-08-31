/**
 * Telemetry model tests (learning module domain; WORK-014 / LRN-001).
 *
 * Required-test mapping:
 *  - closed-shape validation of the observation record;
 *  - M10: no source execution ⇒ unrepresentable (fail closed);
 *  - M11: no evidence references ⇒ unrepresentable (fail closed);
 *  - M12: no tenant/application identity ⇒ unrepresentable (fail closed);
 *  - the outcome vocabulary is the execution terminal-state observation
 *    vocabulary (learning never invents outcome classes);
 *  - money/latency shape discipline (integer micro-USD, integer ms);
 *  - fingerprint basis determinism (identical observations ⇒ identical
 *    basis; any semantic change diverges).
 */

import { describe, expect, test } from "vitest";
import {
  type ExecutionOutcomeTelemetry,
  isTelemetryOutcome,
  TELEMETRY_OUTCOMES,
  TELEMETRY_SCHEMA_VERSION,
  telemetryFingerprintBasis,
  validateExecutionTelemetry,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";

function validTelemetry(): ExecutionOutcomeTelemetry {
  return {
    telemetryId: "00000000-0000-7000-8000-0000000000c1",
    executionId: "00000000-0000-7000-8000-0000000000d1",
    applicationId: APP,
    tenantId: TENANT,
    taskClass: "interpretation",
    capabilities: ["text-generation"],
    planId: "plan-digest-1",
    planRevision: 1,
    strategyClass: "generative",
    routes: [{ provider: "rail-a", model: "model-x" }],
    tools: [],
    environments: [],
    verification: {
      resultIds: ["ver-1"],
      statuses: ["PASS"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: 1,
      failCount: 0,
      inconclusiveCount: 0,
      verified: true,
    },
    costMicroUsd: "1250",
    latencyMs: 1800,
    outcome: "execution-completed",
    recordedAt: "2026-09-15T12:00:00Z",
    evidenceRefs: ["execution:00000000-0000-7000-8000-0000000000d1:receipt"],
    subgraphs: [{ subgraphId: "step:s1", stepPath: ["s1"], computationType: "generative" }],
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
  };
}

describe("execution outcome telemetry model", () => {
  test("a fully-bound observation validates", () => {
    const datum = validTelemetry();
    expect(() => validateExecutionTelemetry(datum)).not.toThrow();
  });

  test("M10: an observation without a source execution is rejected", () => {
    const datum = validTelemetry();
    delete (datum as { executionId?: string }).executionId;
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
    try {
      validateExecutionTelemetry(datum);
    } catch (error) {
      expect((error as PlatformError).details).toMatchObject({ field: "executionId" });
    }
  });

  test("M11: an observation without evidence references is rejected", () => {
    const datum = validTelemetry();
    (datum as unknown as { evidenceRefs: string[] }).evidenceRefs = [];
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("M12: an observation without tenant identity is rejected", () => {
    for (const field of ["tenantId", "applicationId"] as const) {
      const datum = validTelemetry();
      delete (datum as unknown as Record<string, unknown>)[field];
      expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
    }
  });

  test("the outcome vocabulary is exactly the execution terminal observations", () => {
    expect(TELEMETRY_OUTCOMES).toEqual([
      "execution-completed",
      "execution-failed",
      "execution-cancelled",
      "execution-expired",
    ]);
    for (const outcome of TELEMETRY_OUTCOMES) {
      expect(isTelemetryOutcome(outcome)).toBe(true);
    }
    expect(isTelemetryOutcome("PASS")).toBe(false);
    expect(isTelemetryOutcome("provider-success")).toBe(false);
  });

  test("a non-vocabulary outcome is rejected (learning never invents outcome classes)", () => {
    const datum = validTelemetry();
    (datum as { outcome: string }).outcome = "verification-passed";
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("verification observations must align result ids and statuses one-to-one", () => {
    const datum = validTelemetry();
    (datum.verification as unknown as { statuses: string[] }).statuses = ["PASS", "FAIL"];
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("verification verified is boolean-or-null, never a coerced string", () => {
    const datum = validTelemetry();
    (datum.verification as { verified: unknown }).verified = "yes";
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("cost must be an integer micro-USD string (floats rejected)", () => {
    const datum = validTelemetry();
    (datum as { costMicroUsd: string }).costMicroUsd = "12.5";
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
    (datum as { costMicroUsd: string }).costMicroUsd = "-1";
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("latency must be a non-negative integer", () => {
    const datum = validTelemetry();
    (datum as { latencyMs: number }).latencyMs = -1;
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
    (datum as { latencyMs: number }).latencyMs = 1.5;
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("routes are neutral provider/model strings; malformed routes rejected", () => {
    const datum = validTelemetry();
    (datum as { routes: unknown }).routes = [{ provider: "rail-a" }];
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("subgraph computation types use the planning vocabulary", () => {
    const datum = validTelemetry();
    {
      const subgraphs = datum.subgraphs as unknown as { computationType: string }[];
      const first = subgraphs[0];
      if (first !== undefined) {
        first.computationType = "quantum";
      }
    }
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("schema version must be a positive integer", () => {
    const datum = validTelemetry();
    (datum as { schemaVersion: number }).schemaVersion = 0;
    expect(() => validateExecutionTelemetry(datum)).toThrow(PlatformError);
  });

  test("the fingerprint basis is deterministic and content-sensitive", () => {
    const basis = telemetryFingerprintBasis(validTelemetry());
    const same = telemetryFingerprintBasis(validTelemetry());
    expect(basis).toEqual(same);

    const mutated = validTelemetry();
    (mutated as { costMicroUsd: string }).costMicroUsd = "9999";
    expect(telemetryFingerprintBasis(mutated)).not.toEqual(basis);

    // Identity and wall-clock are NOT observation content: identical
    // observations with different ids/timestamps share the basis.
    const shifted = validTelemetry();
    (shifted as { telemetryId: string }).telemetryId = "00000000-0000-7000-8000-0000000000c2";
    (shifted as { recordedAt: string }).recordedAt = "2027-01-01T00:00:00Z";
    expect(telemetryFingerprintBasis(shifted)).toEqual(basis);
  });
});
