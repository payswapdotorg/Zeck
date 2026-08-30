/**
 * Unit — the tool registry (tool admission surface): validated contracts +
 * bound adapters, convergence on identical re-registration, immutability of
 * registered contracts, and unregistered tools resolving to null (an
 * unregistered tool cannot be invoked by construction).
 */

import { describe, expect, test } from "vitest";
import type { ToolAdapter } from "../../../src/modules/tools/public";
import {
  CALCULATOR_CONTRACT,
  calculatorAdapter,
  createToolRegistry,
  type ToolContract,
} from "../../../src/modules/tools/public";

const echoAdapter: ToolAdapter = {
  async execute(dispatch) {
    return { kind: "tool-success", output: { echoed: dispatch.input } };
  },
};

describe("tool registry", () => {
  test("registers a valid contract and resolves the same binding", async () => {
    const registry = createToolRegistry();
    const outcome = await registry.register(CALCULATOR_CONTRACT, calculatorAdapter);
    expect(outcome).toEqual({ status: "registered", toolId: "calculator", version: "1.0.0" });
    const resolved = await registry.resolve("calculator");
    expect(resolved?.contract).toBe(CALCULATOR_CONTRACT);
    expect(resolved?.adapter).toBe(calculatorAdapter);
  });

  test("an invalid contract is rejected and never resolvable", async () => {
    const registry = createToolRegistry();
    const invalid: ToolContract = { ...CALCULATOR_CONTRACT, toolId: "BAD ID" };
    const outcome = await registry.register(invalid, calculatorAdapter);
    expect(outcome.status).toBe("rejected");
    expect(await registry.resolve("BAD ID")).toBeNull();
    expect((await registry.listContracts()).length).toBe(0);
  });

  test("identical re-registration converges", async () => {
    const registry = createToolRegistry();
    await registry.register(CALCULATOR_CONTRACT, calculatorAdapter);
    const outcome = await registry.register(CALCULATOR_CONTRACT, calculatorAdapter);
    expect(outcome.status).toBe("converged");
    expect((await registry.listContracts()).length).toBe(1);
  });

  test("a different contract for the same identity is rejected (immutable contracts)", async () => {
    const registry = createToolRegistry();
    await registry.register(CALCULATOR_CONTRACT, calculatorAdapter);
    const mutated: ToolContract = {
      ...CALCULATOR_CONTRACT,
      cost: { estimatedMicroUsd: "10" },
    };
    const outcome = await registry.register(mutated, calculatorAdapter);
    expect(outcome.status).toBe("rejected");
    const resolved = await registry.resolve("calculator");
    expect(resolved?.contract.cost.estimatedMicroUsd).toBe("0");
  });

  test("a different version for the same toolId is rejected (new identity required)", async () => {
    const registry = createToolRegistry();
    await registry.register(CALCULATOR_CONTRACT, calculatorAdapter);
    const bumped: ToolContract = { ...CALCULATOR_CONTRACT, version: "2.0.0" };
    const outcome = await registry.register(bumped, calculatorAdapter);
    expect(outcome.status).toBe("rejected");
  });

  test("unregistered tools resolve to null (invocation impossible by construction)", async () => {
    const registry = createToolRegistry();
    await registry.register(CALCULATOR_CONTRACT, calculatorAdapter);
    expect(await registry.resolve("not-registered")).toBeNull();
    expect(await registry.resolve("")).toBeNull();
  });

  test("concurrent identical registrations converge under the arbitration lock", async () => {
    const registry = createToolRegistry();
    const outcomes = await Promise.all([
      registry.register(CALCULATOR_CONTRACT, echoAdapter),
      registry.register(CALCULATOR_CONTRACT, echoAdapter),
      registry.register(CALCULATOR_CONTRACT, echoAdapter),
    ]);
    expect(outcomes.filter((o) => o.status === "registered")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "converged")).toHaveLength(2);
    expect((await registry.listContracts()).length).toBe(1);
  });

  test("listContracts exposes registered contracts for evidence/inspection", async () => {
    const registry = createToolRegistry();
    await registry.register(CALCULATOR_CONTRACT, calculatorAdapter);
    const contracts = await registry.listContracts();
    expect(contracts.map((c) => c.toolId)).toEqual(["calculator"]);
  });
});
