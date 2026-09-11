/**
 * VAL-009 acceptance criteria 1, 4, 5 — the capability matrix contract:
 * every corpus-declared capability exists in the matrix, readiness
 * resolves ONLY from probe outcomes (never silently), gaps carry the
 * exact access requirement, and probe records are secret-free.
 */

import { describe, expect, test } from "vitest";
import {
  CAPABILITY_MATRIX,
  corpusCapabilityCoverage,
  PROVIDER_ACCESS,
  type ProbeResult,
  resolveMatrix,
  validateProbeResult,
} from "../../../benchmarks/validation/capabilities";
import { GOLDEN_TASKS } from "../../../benchmarks/validation/corpus";

describe("validation: capability matrix (VAL-009 AC1/AC5)", () => {
  test("the matrix covers every corpus-declared capability, exactly", () => {
    expect(corpusCapabilityCoverage(GOLDEN_TASKS)).toEqual([]);
  });

  test("the matrix enumerates the 11 corpus capabilities", () => {
    expect(CAPABILITY_MATRIX.length).toBe(11);
    expect(CAPABILITY_MATRIX.filter((d) => d.candidates.length === 0).length).toBe(3);
  });

  test("the provider registry references credentials by env-var NAME only", () => {
    for (const access of PROVIDER_ACCESS) {
      expect(access.credentialEnvVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(JSON.stringify(access)).not.toMatch(/(sk-|ghp_|gho_|apikey-|ak_|ck_)/);
    }
  });
});

describe("validation: readiness resolution (VAL-009 AC4)", () => {
  test("a capability with a successful candidate probe resolves READY", () => {
    const resolution = resolveMatrix({ openrouter: "ready" });
    const text = resolution.find((r) => r.capability === "model:text");
    expect(text?.status).toBe("ready");
    expect(text?.readyProviders).toContain("openrouter");
  });

  test("a capability with no successful probe resolves GAP with the exact access requirement", () => {
    const resolution = resolveMatrix({});
    const threeD = resolution.find((r) => r.capability === "model:three-d");
    expect(threeD?.status).toBe("gap");
    expect(threeD?.accessRequirement).toContain("no 3D-generation provider access");
    const browser = resolution.find((r) => r.capability === "agent:browser");
    expect(browser?.status).toBe("gap");
    expect(browser?.accessRequirement).toContain("browser-agent execution infrastructure");
  });

  test("a FAILED candidate probe keeps the capability a gap (never a silent pass)", () => {
    const resolution = resolveMatrix({ openai: "failed" });
    const asr = resolution.find((r) => r.capability === "model:asr");
    expect(asr?.status).toBe("gap");
    expect(asr?.pendingProviders).toContain("openai");
  });

  test("every resolution carries an operator-facing access requirement", () => {
    for (const resolution of resolveMatrix({})) {
      expect(resolution.accessRequirement.length).toBeGreaterThan(20);
    }
  });
});

describe("validation: probe result contract (VAL-009 AC2/AC3)", () => {
  const valid: ProbeResult = {
    provider: "openrouter",
    credentialEnvVar: "OPENROUTER_API_KEY",
    at: "2026-09-11T22:30:00.000Z",
    outcome: "ready",
    latencyMs: 812,
    detail: "HTTP 200 — chat completion returned",
  };

  test("a clean probe record validates", () => {
    expect(validateProbeResult(valid)).toEqual([]);
  });

  test("a failed probe must classify its failure (discrimination)", () => {
    const broken: ProbeResult = {
      ...valid,
      outcome: "failed",
      detail: "HTTP 401",
    };
    expect(validateProbeResult(broken).some((v) => v.path === "failure")).toBe(true);
  });

  test("secret-shaped material in a probe record is rejected (discrimination)", () => {
    const leaked: ProbeResult = {
      ...valid,
      detail: "HTTP 200 with key sk-or-v1-892d3157e3474c17aa16a0665453c86a visible",
    };
    expect(validateProbeResult(leaked).some((v) => v.path === "detail")).toBe(true);
  });

  test("a non-micro-USD cost fact is rejected (discrimination)", () => {
    const broken: ProbeResult = { ...valid, costMicroUsd: "0.5" };
    expect(validateProbeResult(broken).some((v) => v.path === "costMicroUsd")).toBe(true);
  });

  test("a negative latency is rejected (discrimination)", () => {
    const broken: ProbeResult = { ...valid, latencyMs: -1 };
    expect(validateProbeResult(broken).some((v) => v.path === "latencyMs")).toBe(true);
  });
});
