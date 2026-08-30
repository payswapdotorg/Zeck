/**
 * Unit — the provider-neutral tool contract (WORK-010 acceptance criterion 1).
 *
 * Valid contracts pass; every malformed dimension fails closed; internal
 * consistency (determinism vs side effects, egress/host coherence,
 * secret-access/ref coherence) is enforced at validation time so an
 * invalid contract can never be registered (and therefore never invoked).
 */

import { describe, expect, test } from "vitest";
import {
  TOOL_EGRESS_MODES,
  TOOL_SECRET_ACCESS_MODES,
  TOOL_SIDE_EFFECT_CLASSES,
  type ToolContract,
  validateToolContract,
} from "../../../src/modules/tools/public";

const base: ToolContract = {
  toolId: "calculator",
  version: "1.0.0",
  capability: { id: "arithmetic", kind: "tool", minVersion: "1.0.0" },
  inputSchema: { fields: [{ name: "operation", type: "string", required: true }] },
  outputSchema: { fields: [{ name: "result", type: "string", required: true }] },
  execution: { deterministic: true, timeoutMs: 5_000, idempotent: true },
  sideEffect: "none",
  network: { egress: "none", hosts: [] },
  secrets: { access: "none", refs: [] },
  cost: { estimatedMicroUsd: "0" },
  evidence: { producesArtifacts: false },
};

describe("tool contract validation", () => {
  test("the reference contract is valid", () => {
    expect(validateToolContract(base)).toEqual({ valid: true });
  });

  test("the frozen dimension vocabularies are exactly the declared classes", () => {
    expect(TOOL_SIDE_EFFECT_CLASSES).toEqual(["none", "read-only", "write-external"]);
    expect(TOOL_EGRESS_MODES).toEqual(["none", "allowlist"]);
    expect(TOOL_SECRET_ACCESS_MODES).toEqual(["none", "allowlist"]);
  });

  test("identity: toolId must be a lowercase identifier; version numerics", () => {
    expect(validateToolContract({ ...base, toolId: "Bad ID" }).valid).toBe(false);
    expect(validateToolContract({ ...base, toolId: "" }).valid).toBe(false);
    expect(validateToolContract({ ...base, version: "1.0" }).valid).toBe(false);
    expect(validateToolContract({ ...base, version: "v1.0.0" }).valid).toBe(false);
  });

  test("capability identity is required with a valid minVersion", () => {
    expect(
      validateToolContract({ ...base, capability: { ...base.capability, id: "" } }).valid,
    ).toBe(false);
    expect(
      validateToolContract({ ...base, capability: { ...base.capability, minVersion: "1" } }).valid,
    ).toBe(false);
    expect(
      validateToolContract({
        ...base,
        capability: undefined as unknown as ToolContract["capability"],
      }).valid,
    ).toBe(false);
  });

  test("input/output schemas must declare fields", () => {
    expect(validateToolContract({ ...base, inputSchema: { fields: [] } }).valid).toBe(false);
    expect(validateToolContract({ ...base, outputSchema: { fields: [] } }).valid).toBe(false);
    expect(
      validateToolContract({
        ...base,
        inputSchema: { fields: [{ name: "a", type: "vector" as never, required: true }] },
      }).valid,
    ).toBe(false);
  });

  test("execution requirements: timeout bounds, booleans", () => {
    expect(
      validateToolContract({ ...base, execution: { ...base.execution, timeoutMs: 0 } }).valid,
    ).toBe(false);
    expect(
      validateToolContract({ ...base, execution: { ...base.execution, timeoutMs: 700_001 } }).valid,
    ).toBe(false);
    expect(
      validateToolContract({
        ...base,
        execution: { ...base.execution, deterministic: "yes" as unknown as boolean },
      }).valid,
    ).toBe(false);
  });

  test("deterministic tools cannot declare external writes (disjoint dimensions)", () => {
    const mutant: ToolContract = { ...base, sideEffect: "write-external" };
    expect(validateToolContract(mutant)).toEqual({
      valid: false,
      reason: expect.stringContaining("deterministic tool cannot declare external writes"),
    });
  });

  test("network coherence: no hosts with egress none; hosts required for allowlist; no duplicates", () => {
    expect(
      validateToolContract({ ...base, network: { egress: "none", hosts: ["api.example.com"] } })
        .valid,
    ).toBe(false);
    expect(
      validateToolContract({ ...base, network: { egress: "allowlist", hosts: [] } }).valid,
    ).toBe(false);
    expect(
      validateToolContract({
        ...base,
        network: { egress: "allowlist", hosts: ["api.example.com", "api.example.com"] },
      }).valid,
    ).toBe(false);
    expect(
      validateToolContract({ ...base, network: { egress: "allowlist", hosts: ["not a host!"] } })
        .valid,
    ).toBe(false);
  });

  test("secret coherence: refs are opaque references (never values); mode/refs agree", () => {
    expect(
      validateToolContract({ ...base, secrets: { access: "none", refs: ["ref-1"] } }).valid,
    ).toBe(false);
    expect(
      validateToolContract({ ...base, secrets: { access: "allowlist", refs: [] } }).valid,
    ).toBe(false);
    expect(
      validateToolContract({ ...base, secrets: { access: "allowlist", refs: ["a", "a"] } }).valid,
    ).toBe(false);
  });

  test("cost expectations: integer micro-USD strings only (WORK-004 money convention)", () => {
    expect(validateToolContract({ ...base, cost: { estimatedMicroUsd: "1.5" } }).valid).toBe(false);
    expect(validateToolContract({ ...base, cost: { estimatedMicroUsd: "-1" } }).valid).toBe(false);
    expect(
      validateToolContract({ ...base, cost: { estimatedMicroUsd: 0 as unknown as string } }).valid,
    ).toBe(false);
  });

  test("non-object contracts fail closed", () => {
    expect(validateToolContract(null).valid).toBe(false);
    expect(validateToolContract("calculator").valid).toBe(false);
    expect(validateToolContract([]).valid).toBe(false);
  });
});
