/**
 * Discrimination: the governed tool runtime boundary (WORK-010 CRITICAL
 * boundaries; checkpoint contracts POLICY-BEFORE-DISPATCH,
 * EXTERNAL-SIDE-EFFECTS, BUDGET-INTEGRITY, EXECUTION-PROVENANCE,
 * TENANT-ISOLATION, VERIFICATION-SEPARATION).
 *
 * Every protection is proven by a mutant that removes it:
 *
 *   STATIC (the shared scanner over mutated REAL source — the WORK-006/007
 *   red-record pattern; the architecture gate runs the same scanner over
 *   the real tree, so it FAILS under exactly these mutations):
 *     M1  policy gate deleted / M2 moved after dispatch / M3 denial branch
 *         dropped  — no gate, no tool dispatch.
 *     M4  capability gate deleted / M5 moved after dispatch / M20 policy
 *         evaluated after capability (order violation).
 *     M6  budget fail-closed removed (costed tool executes unbudgeted).
 *     M7  tenant-scope check removed / M8 terminal-execution check removed.
 *     M9  durable intent removed / M10 ledger intent event removed /
 *         M11 ledger result event removed.
 *     M12 default-allow admission factory shipped / M13 no-op ledger
 *         shipped — both impossible in the tools module.
 *     M14/M15/M16 the three seam adapters stop delegating to the real
 *         authorities (second-engine mutants).
 *     M17 the policy seam becomes optional wiring.
 *     M18 tools imports the models module (provider-fabric leakage) /
 *         M19 tools references the executions tables (second ledger).
 *
 *   RUNTIME RED RECORDS (observed violations under CONSTRUCTED wiring
 *     mutants — the wiring failure each static protection makes
 *     unrepresentable; production blocks the identical scenario):
 *     R1 allow-all admission wired while the REAL policy denies → the
 *        adapter executes (violation); production: typed POLICY_DENIED,
 *        zero dispatches.
 *     R2 always-satisfied capability gate wired while the capability is
 *        unmet → the adapter executes (violation); production: typed
 *        CAPABILITY_UNAVAILABLE, zero dispatches.
 *     R3 permissive budget authority wired while the REAL budget denies →
 *        the costed tool executes (violation); production: BUDGET_EXCEEDED.
 *     R4 a registry that hands out adapters for unregistered tools → the
 *        ghost tool executes (violation); production: typed failure.
 *     R5 a no-op ledger wired → the invocation succeeds with ZERO execution
 *        ledger events (violation of the canonical-event-path boundary);
 *        production: exactly one requested + one result envelope.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BudgetAuthority } from "../../src/modules/budgets/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../src/modules/policies/public";
import type { ExecutionLedger } from "../../src/modules/tools/ports/execution-ledger";
import type { ToolAdapter } from "../../src/modules/tools/ports/tool-adapter";
import type { ToolAdmission } from "../../src/modules/tools/ports/tool-admission";
import type { ToolCapabilityResolution } from "../../src/modules/tools/ports/tool-capability-gate";
import type { ToolRegistry } from "../../src/modules/tools/ports/tool-registry";
import { CALCULATOR_CONTRACT } from "../../src/modules/tools/public";
import { PlatformError } from "../../src/shared/errors";
import { createInMemoryToolsWorld, type InMemoryToolsWorld } from "../unit/tools/fakes";
import {
  hasCanonicalToolRuntime,
  type ToolBoundaryFile,
  toolRuntimeViolations,
} from "./lib/tool-runtime";

const REPO_ROOT = join(process.cwd());

function realTree(): ToolBoundaryFile[] {
  const paths = [
    "src/modules/tools/application/tool-runtime.ts",
    "src/modules/tools/adapters/policy-tool-admission.ts",
    "src/modules/tools/adapters/capability-gate.ts",
    "src/modules/tools/adapters/execution-ledger.ts",
  ];
  return paths.map((path) => ({ path, content: readFileSync(join(REPO_ROOT, path), "utf8") }));
}

function mutateRuntime(
  tree: ToolBoundaryFile[],
  replacement: (content: string) => string,
): ToolBoundaryFile[] {
  return tree.map((file) =>
    file.path.endsWith("tool-runtime.ts") ? { ...file, content: replacement(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// Static mutants (the shared scanner must flag each removal)
// ---------------------------------------------------------------------------

describe("discrimination: static admission-chain mutants", () => {
  test("scanner honesty: the unmutated real tree yields ZERO violations", () => {
    const tree = realTree();
    expect(hasCanonicalToolRuntime(tree)).toBe(true);
    expect(toolRuntimeViolations(tree)).toEqual([]);
  });

  test("M1: the policy gate call deleted is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace(
        /const decision = await admission\.admit\(\{[\s\S]*?\n\s*\}\);/,
        "const decision = { allowed: true } as const;",
      ),
    );
    const violations = toolRuntimeViolations(mutant);
    expect(violations).toContain("tool-policy-gate-missing");
  });

  test("M2: the policy gate moved AFTER the dispatch hand-off is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content
        .replace(
          /const decision = await admission\.admit\(\{[\s\S]*?\n\s*\}\);/,
          "const decision = { allowed: true } as const;",
        )
        .replace(
          "        capabilitySatisfaction,\n      },\n    );\n  };",
          "        capabilitySatisfaction,\n      },\n    );\n    const lateDecision = await admission.admit({});\n    void lateDecision;\n  };",
        ),
    );
    const violations = toolRuntimeViolations(mutant);
    expect(violations).toContain("tool-policy-gate-after-dispatch");
  });

  test("M3: the policy denial branch dropped is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace("if (!decision.allowed) {", "if (decision.allowed === false && false) {"),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-policy-gate-no-denial-branch");
  });

  test("M4: the capability gate call deleted is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace(
        /const resolution = await capabilities\.resolve\(\{[\s\S]*?\n\s*\}\);/,
        "const resolution = { satisfied: true, catalogRevision: 'r', satisfactions: [] } as const;",
      ),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-capability-gate-missing");
  });

  test("M5: the capability gate moved AFTER dispatch is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content
        .replace(
          /const resolution = await capabilities\.resolve\(\{[\s\S]*?\n\s*\}\);/,
          "const resolution = { satisfied: true, catalogRevision: 'r', satisfactions: [] } as const;",
        )
        .replace(
          "        capabilitySatisfaction,\n      },\n    );\n  };",
          "        capabilitySatisfaction,\n      },\n    );\n    const lateResolution = await capabilities.resolve({ requirements: [] });\n    void lateResolution;\n  };",
        ),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-capability-gate-after-dispatch");
  });

  test("M20: policy evaluated AFTER capability (order violation) is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content
        .replace(
          /const decision = await admission\.admit\(\{[\s\S]*?\n\s*\}\);/,
          "const decision = { allowed: true } as const;",
        )
        .replace(
          "    if (!resolution.satisfied) {",
          "    const lateDecision = await admission.admit({\n      tenantId: execution.tenantId,\n      applicationId: request.applicationId,\n      executionId: request.executionId,\n      toolId: contract.toolId,\n      hosts: [],\n      secretRefs: [],\n    });\n    if (!lateDecision.allowed) {\n      throw new PlatformError({ code: 'POLICY_DENIED', message: 'late' });\n    }\n    if (!resolution.satisfied) {",
        ),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-policy-gate-after-capability");
  });

  test("M6: the costed-tool budget fail-closed check removed is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace("if (costed && budgetAuthority === undefined) {", "if (false) {"),
    );
    expect(toolRuntimeViolations(mutant)).toContain("costed-tool-budget-bypass");
  });

  test("M7: the tenant-scope check removed is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace("if (execution.tenantId !== request.actor.tenantId) {", "if (false) {"),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-tenant-check-missing");
  });

  test("M8: the terminal-execution check removed is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace(
        'if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {',
        "if (false) {",
      ),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-terminal-check-missing");
  });
});

describe("discrimination: static side-effect/ledger mutants", () => {
  test("M9: the durable intent claim removed is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace("await store.claimDispatching({", "await Promise.resolve(({"),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-durable-intent-missing");
  });

  test("M10: the execution.tool-requested ledger event removed is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace(
        'await appendLedgerEvent(record, "tool-requested", {',
        "await Promise.resolve(({",
      ),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-ledger-intent-event-missing");
  });

  test("M11: the execution.tool-result ledger event removed is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace(
        'await appendLedgerEvent(record, "tool-result", {',
        "await Promise.resolve(({",
      ),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-ledger-result-event-missing");
  });

  test("M12: a default-allow admission factory in the tools module is rejected", () => {
    const mutant = [
      ...realTree(),
      {
        path: "src/modules/tools/adapters/allow-all.ts",
        content:
          "export function createAllowAllToolAdmission(): ToolAdmission {\n  return { admit: async () => ({ allowed: true as const }) };\n}\n",
      },
    ];
    expect(toolRuntimeViolations(mutant)).toContain(
      "no-default-allow-violation:src/modules/tools/adapters/allow-all.ts",
    );
  });

  test("M13: a no-op execution ledger in the tools module is rejected", () => {
    const mutant = [
      ...realTree(),
      {
        path: "src/modules/tools/adapters/noop-ledger.ts",
        content:
          "export const noopLedger = { recordStepEvent: async (_event, _key) => ({ sequence: 0, type: 'x', replayed: true }) };\n",
      },
    ];
    expect(toolRuntimeViolations(mutant)).toContain(
      "no-noop-ledger-violation:src/modules/tools/adapters/noop-ledger.ts",
    );
  });

  test("M14: the admission adapter stops delegating to the policy authority is rejected", () => {
    const mutant = realTree().map((file) =>
      file.path.endsWith("policy-tool-admission.ts")
        ? { ...file, content: file.content.replaceAll("authority.admitDispatch(", "localDecide(") }
        : file,
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-admission-seam-does-not-delegate");
  });

  test("M15: the capability gate stops delegating to the registry is rejected", () => {
    const mutant = realTree().map((file) =>
      file.path.endsWith("capability-gate.ts")
        ? { ...file, content: file.content.replaceAll("registry.resolve(", "localResolve(") }
        : file,
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-capability-seam-does-not-delegate");
  });

  test("M16: the ledger adapter stops delegating to the executions service is rejected", () => {
    const mutant = realTree().map((file) =>
      file.path.endsWith("execution-ledger.ts")
        ? { ...file, content: file.content.replaceAll("service.recordStepEvent(", "localAppend(") }
        : file,
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-ledger-seam-does-not-delegate");
  });

  test("M17: the policy seam becoming optional wiring is rejected", () => {
    const mutant = mutateRuntime(realTree(), (content) =>
      content.replace("readonly admission: ToolAdmission;", "readonly admission?: ToolAdmission;"),
    );
    expect(toolRuntimeViolations(mutant)).toContain("tool-admission-seam-not-required");
  });

  test("M18: the tools module importing the models module is rejected", () => {
    const mutant = [
      ...realTree(),
      {
        path: "src/modules/tools/adapters/leak.ts",
        content: 'import type { ModelRequest } from "../../models/public";\nexport const x = 1;\n',
      },
    ];
    expect(toolRuntimeViolations(mutant)).toContain(
      "tools-imports-model-or-agent:src/modules/tools/adapters/leak.ts",
    );
  });

  test("M19: the tools module referencing the executions tables is rejected", () => {
    const mutant = [
      ...realTree(),
      {
        path: "src/modules/tools/adapters/leak-sql.ts",
        content:
          "export const sql = \"INSERT INTO executions.execution_events (id) VALUES ('1')\";\n",
      },
    ];
    expect(toolRuntimeViolations(mutant)).toContain(
      "tools-references-executions-tables:src/modules/tools/adapters/leak-sql.ts",
    );
  });
});

// ---------------------------------------------------------------------------
// Runtime red records (constructed wiring mutants — observed violations)
// ---------------------------------------------------------------------------

describe("discrimination: runtime red records (wiring mutants)", () => {
  const countingAdapter = (): ToolAdapter & { calls: number } => {
    const adapter = {
      calls: 0,
      async execute() {
        adapter.calls += 1;
        return { kind: "tool-success" as const, output: { result: "42" } };
      },
    };
    return adapter;
  };

  const inputOf = (world: InMemoryToolsWorld, executionId: string) => ({
    applicationId: world.applicationId,
    executionId,
    actor: world.actor(),
    toolId: "calculator",
    input: { operation: "add", left: "20", right: "22" },
  });

  test("R1: allow-all admission wired while the REAL policy denies → the adapter executes (observed violation); production blocks", async () => {
    // PRODUCTION: the REAL policy authority denies the tool.
    const authority = createPolicyAuthority({
      store: new InMemoryPolicyStore(),
      hasher: nodePolicyHasher,
    });
    await authority.publish({
      id: "default",
      version: 1,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: { tool: { deniedTools: ["calculator"] } },
        },
      ],
    });
    const { createPolicyToolAdmission } = await import(
      "../../src/modules/tools/adapters/policy-tool-admission"
    );
    const realAdmission: ToolAdmission = createPolicyToolAdmission(authority);
    const adapter = countingAdapter();
    const world = createInMemoryToolsWorld({ admission: realAdmission });
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution();

    await expect(world.runtime.invoke(inputOf(world, executionId), "r1")).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    expect(adapter.calls).toBe(0); // production: the denied tool is NEVER invoked

    // MUTANT (the wiring failure the static gate makes unrepresentable):
    // an allow-all admission is wired instead of the authority.
    const allowAll: ToolAdmission = { admit: async () => ({ allowed: true }) };
    const mutantWorld = createInMemoryToolsWorld({ admission: allowAll });
    await mutantWorld.registerTool(CALCULATOR_CONTRACT, adapter);
    const mutantExecution = await mutantWorld.seedExecution();
    const result = await mutantWorld.runtime.invoke(
      inputOf(mutantWorld, mutantExecution),
      "r1-mutant",
    );
    // OBSERVED VIOLATION: the adapter executed despite the policy denial.
    expect(result.status).toBe("succeeded");
    expect(adapter.calls).toBe(1);
  });

  test("R2: always-satisfied capability gate wired while the capability is unmet → the adapter executes (observed violation); production blocks", async () => {
    const adapter = countingAdapter();
    // PRODUCTION: the capability is unmet (empty satisfaction catalog).
    const productionWorld = createInMemoryToolsWorld({
      capabilities: {
        resolve: async () => ({
          satisfied: false,
          catalogRevision: "rev",
          unmet: [
            {
              requirementId: "arithmetic",
              kind: "tool" as const,
              reason: "unknown-capability" as const,
              minVersion: null,
            },
          ],
        }),
      },
    });
    await productionWorld.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await productionWorld.seedExecution();
    await expect(
      productionWorld.runtime.invoke(inputOf(productionWorld, executionId), "r2"),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(adapter.calls).toBe(0);

    // MUTANT: a capability gate that always satisfies.
    const permissiveGate: ToolCapabilityResolution = {
      resolve: async (profile) => ({
        satisfied: true,
        catalogRevision: "rev",
        satisfactions: profile.requirements.map((requirement) => ({
          requirementId: requirement.id,
          claimId: requirement.id,
          claimKind: requirement.kind,
          claimVersion: requirement.minVersion ?? "1.0.0",
          evidenceKind: "adapter-declared" as const,
          evidenceReference: "fabricated",
          publisher: "mutant",
        })),
      }),
    };
    const mutantWorld = createInMemoryToolsWorld({ capabilities: permissiveGate });
    await mutantWorld.registerTool(CALCULATOR_CONTRACT, adapter);
    const mutantExecution = await mutantWorld.seedExecution();
    const result = await mutantWorld.runtime.invoke(
      inputOf(mutantWorld, mutantExecution),
      "r2-mutant",
    );
    // OBSERVED VIOLATION: an unmet capability executed (fabricated evidence).
    expect(result.status).toBe("succeeded");
    expect(adapter.calls).toBe(1);
  });

  test("R3: permissive budget wired while the REAL budget denies → the costed tool executes (observed violation); production blocks", async () => {
    const costed = {
      ...CALCULATOR_CONTRACT,
      execution: { deterministic: false, timeoutMs: 5000, idempotent: true },
      sideEffect: "write-external" as const,
      cost: { estimatedMicroUsd: "500" },
    };
    const adapter = countingAdapter();

    // PRODUCTION: the real budget authority denies the reservation.
    const denyingBudget: BudgetAuthority = {
      reserve: async () => {
        throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "no funds" });
      },
      settle: async () => {
        throw new Error("unreachable");
      },
      release: async () => {
        throw new Error("unreachable");
      },
    };
    const productionWorld = createInMemoryToolsWorld({ budgetAuthority: denyingBudget });
    await productionWorld.registerTool(costed, adapter);
    const executionId = await productionWorld.seedExecution();
    await expect(
      productionWorld.runtime.invoke(
        { ...inputOf(productionWorld, executionId), toolId: costed.toolId },
        "r3",
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(adapter.calls).toBe(0);

    // MUTANT: a permissive budget authority (reserve always succeeds).
    const reservation = {
      id: "r",
      applicationId: "a",
      tenantId: "t",
      executionId: "e",
      operationId: "o",
      userId: "",
      fundingMode: "developer" as const,
      sourceKind: "developer" as const,
      walletId: "w",
      amountMicroUsd: "500",
      status: "active" as const,
      settledAmountMicroUsd: null,
      monthKey: "2026-09",
      createdAt: "2026-09-01T00:00:00.000Z",
      finalizedAt: null,
    };
    const permissiveBudget: BudgetAuthority = {
      reserve: async () => ({ reservation, converged: false, replayed: false }),
      settle: async () => ({ reservation, converged: false, replayed: false }),
      release: async () => ({ reservation, converged: false, replayed: false }),
    };
    const mutantWorld = createInMemoryToolsWorld({ budgetAuthority: permissiveBudget });
    await mutantWorld.registerTool(costed, adapter);
    const mutantExecution = await mutantWorld.seedExecution();
    const result = await mutantWorld.runtime.invoke(
      { ...inputOf(mutantWorld, mutantExecution), toolId: costed.toolId },
      "r3-mutant",
    );
    // OBSERVED VIOLATION: the costed tool executed unbudgeted.
    expect(result.status).toBe("succeeded");
    expect(adapter.calls).toBe(1);
  });

  test("R4: a registry handing out adapters for unregistered tools → the ghost tool executes (observed violation); production blocks", async () => {
    const adapter = countingAdapter();
    // PRODUCTION: the ghost tool is unregistered.
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution();
    await expect(
      world.runtime.invoke({ ...inputOf(world, executionId), toolId: "ghost" }, "r4"),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(adapter.calls).toBe(0);

    // MUTANT: a registry that fabricates bindings for any toolId.
    const fabricatingRegistry: ToolRegistry = {
      async register() {
        throw new Error("unused");
      },
      async resolve(toolId) {
        return toolId === "ghost" ? { contract: CALCULATOR_CONTRACT, adapter } : null;
      },
      async listContracts() {
        return [];
      },
    };
    const mutantWorld = createInMemoryToolsWorld();
    // Wire the fabricating registry through a runtime re-construction:
    const { createToolRuntime } = await import("../../src/modules/tools/application/tool-runtime");
    const { createExecutionLedgerAdapter } = await import(
      "../../src/modules/tools/adapters/execution-ledger"
    );
    const mutantRuntime = createToolRuntime({
      registry: fabricatingRegistry,
      admission: world.admission.impl,
      capabilities: world.capabilities.impl,
      budgetAuthority: world.budgets.impl,
      store: mutantWorld.toolStore,
      ledger: createExecutionLedgerAdapter(mutantWorld.executionService),
      generateId: () =>
        `00000000-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
      now: () => new Date(),
      hashInput: (input) => `digest:${JSON.stringify(input)}`,
    });
    const mutantExecution = await mutantWorld.seedExecution();
    const result = await mutantRuntime.invoke(
      {
        applicationId: mutantWorld.applicationId,
        executionId: mutantExecution,
        actor: mutantWorld.actor(),
        toolId: "ghost",
        input: { operation: "add", left: "1", right: "1" },
      },
      "r4-mutant",
    );
    // OBSERVED VIOLATION: an unregistered tool was dispatched.
    expect(result.status).toBe("succeeded");
    expect(adapter.calls).toBe(1);
  });

  test("R5: a no-op ledger wired → the invocation succeeds with ZERO execution events (observed violation); production records the canonical pair", async () => {
    const adapter = countingAdapter();
    // PRODUCTION: the canonical ledger records both envelopes.
    const world = createInMemoryToolsWorld();
    await world.registerTool(CALCULATOR_CONTRACT, adapter);
    const executionId = await world.seedExecution();
    const result = await world.runtime.invoke(inputOf(world, executionId), "r5");
    expect(result.status).toBe("succeeded");
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(events.filter((event) => event.type.startsWith("execution.tool-"))).toHaveLength(2);

    // MUTANT: a no-op ledger (the wiring failure the REQUIRED seam makes
    // unrepresentable in the module itself).
    const noopLedger: ExecutionLedger = {
      recordStepEvent: async () => ({ sequence: 0, type: "noop", replayed: false }),
      getExecution: async (applicationId, id) =>
        mutantWorld.executionService.getExecution(applicationId, id),
    };
    const { createToolRuntime } = await import("../../src/modules/tools/application/tool-runtime");
    const mutantWorld = createInMemoryToolsWorld();
    await mutantWorld.registerTool(CALCULATOR_CONTRACT, adapter);
    const mutantExecution = await mutantWorld.seedExecution();
    const mutantRuntime = createToolRuntime({
      registry: {
        async register() {
          throw new Error("unused");
        },
        async resolve(toolId) {
          return toolId === "calculator"
            ? { contract: CALCULATOR_CONTRACT, adapter: countingAdapter() }
            : null;
        },
        async listContracts() {
          return [CALCULATOR_CONTRACT];
        },
      },
      admission: mutantWorld.admission.impl,
      capabilities: mutantWorld.capabilities.impl,
      store: mutantWorld.toolStore,
      ledger: noopLedger,
      generateId: () =>
        `00000000-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, "0")}`,
      now: () => new Date(),
      hashInput: (input) => `digest:${JSON.stringify(input)}`,
    });
    const mutantResult = await mutantRuntime.invoke(
      {
        applicationId: mutantWorld.applicationId,
        executionId: mutantExecution,
        actor: mutantWorld.actor(),
        toolId: "calculator",
        input: { operation: "add", left: "1", right: "1" },
      },
      "r5-mutant",
    );
    // OBSERVED VIOLATION: success with ZERO canonical execution events —
    // exactly the "bypass the canonical execution event path" mutant.
    expect(mutantResult.status).toBe("succeeded");
    const mutantEvents = await mutantWorld.executionService.listEvents(
      mutantWorld.applicationId,
      mutantExecution,
    );
    expect(mutantEvents.filter((event) => event.type.startsWith("execution.tool-"))).toHaveLength(
      0,
    );
  });
});
