/**
 * Unit tests — the synthesis service (WORK-018, TOL-004).
 *
 * Proves the governed lifecycle end-to-end at the application layer with
 * the REAL domain/store/registry/adapter-factory wiring and a test
 * double ONLY at the `SynthesisSandboxExecutor` port (the port is the
 * pinned boundary; its real implementation — the sandbox-manager
 * wrapper — is proven against real PostgreSQL in
 * tests/integration/postgres/tools-synthesis.test.ts):
 *
 *   - submission: fail-closed validation before durability, idempotent
 *     replay convergence, key-reuse rejection;
 *   - compilation: draft→validated with evidence; forbidden-token
 *     rejection (the v1 language subset);
 *   - runtime tests: validated→usable only when every case passes
 *     THROUGH the executor; per-case evidence with sandbox identities;
 *     mismatch/failure → rejected; replay convergence;
 *   - binding: only usable + unexpired programs register into THE tool
 *     registry; retirement and expiry fail closed;
 *   - invocation: the synthesized tool adapter executes through the
 *     SAME executor port and parses output fail-closed;
 *   - the fact projection carries the synthesized origin.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  SynthesisSandboxDispatch,
  SynthesisSandboxExecutor,
  SynthesisSandboxResult,
  SynthesisService,
  SynthesisTestCase,
  ToolContract,
  ToolRegistry,
} from "../../../src/modules/tools/public";
import {
  createSynthesisService,
  createSynthesizedAdapterFactory,
  createToolRegistry,
  InMemorySynthesisStore,
} from "../../../src/modules/tools/public";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

const ACTOR = {
  actorId: "00000000-0000-7000-8000-0000000000e1",
  applicationId: "00000000-0000-7000-8000-0000000000e2",
  tenantId: "00000000-0000-7000-8000-0000000000e3",
};

function contract(toolId = "synth-doubler"): ToolContract {
  return {
    toolId,
    version: "1.0.0",
    capability: { id: "arithmetic", kind: "tool", minVersion: "1.0.0" },
    inputSchema: { fields: [{ name: "value", type: "number", required: true }] },
    outputSchema: { fields: [{ name: "doubled", type: "number", required: true }] },
    execution: { deterministic: true, timeoutMs: 5000, idempotent: true },
    sideEffect: "none",
    network: { egress: "none", hosts: [] },
    secrets: { access: "none", refs: [] },
    cost: { estimatedMicroUsd: "0" },
    evidence: { producesArtifacts: false },
  };
}

const TEST_CASES: readonly SynthesisTestCase[] = [
  { name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } },
  { name: "doubles-zero", input: { value: 0 }, expectedOutput: { doubled: 0 } },
];

/** A deterministic executor double: doubles `value`, echoes provenance. */
function executorDouble(behavior: "ok" | "fail" | "wrong-output" = "ok"): {
  executor: SynthesisSandboxExecutor;
  calls: SynthesisSandboxDispatch[];
} {
  const calls: SynthesisSandboxDispatch[] = [];
  const executor: SynthesisSandboxExecutor = {
    async execute(dispatch): Promise<SynthesisSandboxResult> {
      calls.push(dispatch);
      if (behavior === "fail") {
        return {
          outcome: "failure",
          failureClass: "sandbox-execution",
          message: "the doubled sandbox failed",
          sandboxId: "00000000-0000-7000-8000-0000000000f1",
        };
      }
      if (behavior === "wrong-output") {
        return {
          outcome: "success",
          stdout: JSON.stringify({ doubled: -1 }),
          outputDigest: "irrelevant",
          durationMs: 1,
          sandboxId: "00000000-0000-7000-8000-0000000000f1",
        };
      }
      const value = (dispatch.input as { value: number }).value;
      return {
        outcome: "success",
        stdout: JSON.stringify({ doubled: value * 2 }),
        outputDigest: "irrelevant",
        durationMs: 1,
        sandboxId: "00000000-0000-7000-8000-0000000000f1",
      };
    },
  };
  return { executor, calls };
}

function buildService(behavior: "ok" | "fail" | "wrong-output" = "ok"): {
  service: SynthesisService;
  store: InMemorySynthesisStore;
  registry: ToolRegistry;
  calls: SynthesisSandboxDispatch[];
} {
  const store = new InMemorySynthesisStore();
  const { executor, calls } = executorDouble(behavior);
  const registry = createToolRegistry();
  const service = createSynthesisService({
    store,
    sandbox: executor,
    registry,
    adapterFactory: createSynthesizedAdapterFactory({
      sandbox: executor,
      store,
      now: () => new Date("2026-01-01T00:00:00Z"),
    }),
    digest,
    generateId: (() => {
      let n = 0;
      return () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
    })(),
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  return { service, store, registry, calls };
}

const GOOD_SOURCE = "const input = 1; const out = { doubled: input * 2 };";

async function submitCompileTest(
  service: SynthesisService,
  source = GOOD_SOURCE,
  behavior: "ok" | "fail" | "wrong-output" | "skip-tests" = "ok",
): Promise<string> {
  const outcome = await service.submitProgram(
    {
      source,
      language: "javascript",
      contract: contract(),
      testCases: TEST_CASES,
      expiresAt: "2099-01-01T00:00:00Z",
    },
    "key-1",
    ACTOR,
  );
  if (outcome.status === "rejected") {
    throw new Error(`submission rejected: ${outcome.reason}`);
  }
  const programId = outcome.program.id;
  await service.compileProgram(programId, ACTOR);
  if (behavior !== "skip-tests") {
    await service.testProgram(programId, ACTOR, "00000000-0000-7000-8000-0000000000e9");
  }
  return programId;
}

describe("submission (fail-closed before durability)", () => {
  test("a valid submission persists a draft row", async () => {
    const { service, store } = buildService();
    const outcome = await service.submitProgram(
      {
        source: GOOD_SOURCE,
        language: "javascript",
        contract: contract(),
        testCases: TEST_CASES,
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "key-1",
      ACTOR,
    );
    expect(outcome.status).toBe("submitted");
    if (outcome.status === "submitted") {
      expect(outcome.program.status).toBe("draft");
      expect(outcome.program.toolId).toBe("synth-doubler");
      expect(outcome.program.testCases).toHaveLength(2);
    }
    expect(await store.listByApplication(ACTOR.applicationId)).toHaveLength(1);
  });

  test("an invalid submission is rejected WITHOUT a durable row", async () => {
    const { service, store } = buildService();
    const outcome = await service.submitProgram(
      {
        source: "const key = 'sk-abcdefghijklmnopqrstuvwx';",
        language: "javascript",
        contract: contract(),
        testCases: TEST_CASES,
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "key-1",
      ACTOR,
    );
    expect(outcome.status).toBe("rejected");
    expect(await store.listByApplication(ACTOR.applicationId)).toHaveLength(0);
  });

  test("a non-synth toolId is rejected before durability", async () => {
    const { service } = buildService();
    const outcome = await service.submitProgram(
      {
        source: GOOD_SOURCE,
        language: "javascript",
        contract: contract("calculator"),
        testCases: TEST_CASES,
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "key-1",
      ACTOR,
    );
    expect(outcome.status).toBe("rejected");
  });

  test("an already-expired program is rejected at submission", async () => {
    const { service } = buildService();
    const outcome = await service.submitProgram(
      {
        source: GOOD_SOURCE,
        language: "javascript",
        contract: contract(),
        testCases: TEST_CASES,
        expiresAt: "2020-01-01T00:00:00Z",
      },
      "key-1",
      ACTOR,
    );
    expect(outcome.status).toBe("rejected");
  });

  test("the same key + same submission converges (replay)", async () => {
    const { service } = buildService();
    const request = {
      source: GOOD_SOURCE,
      language: "javascript",
      contract: contract(),
      testCases: TEST_CASES,
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const first = await service.submitProgram(request, "key-1", ACTOR);
    const second = await service.submitProgram(request, "key-1", ACTOR);
    expect(second.status).toBe("converged");
    if (first.status !== "rejected" && second.status !== "rejected") {
      expect(second.program.id).toBe(first.program.id);
    }
  });

  test("the same key + a DIFFERENT submission fails IDEMPOTENCY_KEY_REUSED", async () => {
    const { service } = buildService();
    await service.submitProgram(
      {
        source: GOOD_SOURCE,
        language: "javascript",
        contract: contract(),
        testCases: TEST_CASES,
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "key-1",
      ACTOR,
    );
    await expect(
      service.submitProgram(
        {
          source: "const input = 2;",
          language: "javascript",
          contract: contract(),
          testCases: TEST_CASES,
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "key-1",
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("tenant scope is enforced on reads", async () => {
    const { service } = buildService();
    const programId = await submitCompileTest(service, GOOD_SOURCE, "skip-tests");
    const other = { ...ACTOR, tenantId: "00000000-0000-7000-8000-0000000000ff" };
    await expect(service.compileProgram(programId, other)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    // Reads outside the owning application are unreachable.
    const otherApp = "00000000-0000-7000-8000-0000000000ee";
    expect(await service.getProgram(otherApp, programId)).toBeNull();
    expect(await service.listPrograms(otherApp)).toHaveLength(0);
  });
});

describe("compilation (static validation gate)", () => {
  test("draft→validated writes the static-validation evidence", async () => {
    const { service } = buildService();
    const programId = await submitCompileTest(service, GOOD_SOURCE, "skip-tests");
    const program = await service.getProgram(ACTOR.applicationId, programId);
    expect(program?.status).toBe("validated");
    expect(program?.staticValidation).not.toBeNull();
    expect(program?.staticValidation?.checks).toContain("v1-language-subset");
    expect(program?.staticValidation?.sourceDigest).toBe(program?.sourceDigest);
  });

  test("a forbidden token rejects the program with evidence", async () => {
    const { service } = buildService();
    const outcome = await service.submitProgram(
      {
        source: "const f = globalThis.fetch; const x = 1;",
        language: "javascript",
        contract: contract(),
        testCases: TEST_CASES,
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "key-1",
      ACTOR,
    );
    if (outcome.status === "rejected") throw new Error(outcome.reason);
    const program = await service.compileProgram(outcome.program.id, ACTOR);
    expect(program.status).toBe("rejected");
    expect(program.rejection?.phase).toBe("static-validation");
    expect(program.rejection?.reason).toContain("forbids the token");
  });

  test("compiling a non-draft program fails closed (replay convergence)", async () => {
    const { service } = buildService();
    const programId = await submitCompileTest(service, GOOD_SOURCE, "skip-tests");
    await expect(service.compileProgram(programId, ACTOR)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });
});

describe("runtime tests (the sandbox-only gate to usable)", () => {
  test("all cases passing → usable, with per-case sandbox provenance", async () => {
    const { service, calls } = buildService();
    const programId = await submitCompileTest(service);
    const program = await service.getProgram(ACTOR.applicationId, programId);
    expect(program?.status).toBe("usable");
    expect(program?.runtimeTests?.passed).toBe(true);
    expect(program?.runtimeTests?.cases).toHaveLength(2);
    for (const evidence of program?.runtimeTests?.cases ?? []) {
      expect(evidence.status).toBe("passed");
      expect(evidence.sandboxId).not.toBeNull();
      expect(evidence.expectedDigest).not.toBeNull();
      expect(evidence.actualDigest).not.toBeNull();
    }
    // Every case executed through the executor port exactly once.
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.idempotencyKey)).toEqual([
      `synth-test:${programId}:doubles-two`,
      `synth-test:${programId}:doubles-zero`,
    ]);
  });

  test("an output mismatch fails the case and rejects the program", async () => {
    const { service } = buildService("wrong-output");
    const programId = await submitCompileTest(service, GOOD_SOURCE, "skip-tests");
    const program = await service.testProgram(
      programId,
      ACTOR,
      "00000000-0000-7000-8000-0000000000e9",
    );
    expect(program.status).toBe("rejected");
    expect(program.rejection?.phase).toBe("runtime-tests");
    expect(program.runtimeTests?.passed).toBe(false);
    expect(program.runtimeTests?.cases[0]?.status).toBe("failed");
  });

  test("an executor failure fails the case and rejects the program", async () => {
    const { service } = buildService("fail");
    const programId = await submitCompileTest(service, GOOD_SOURCE, "skip-tests");
    const program = await service.testProgram(
      programId,
      ACTOR,
      "00000000-0000-7000-8000-0000000000e9",
    );
    expect(program.status).toBe("rejected");
    expect(program.runtimeTests?.cases[0]?.message).toContain("doubled sandbox failed");
  });

  test("replaying tests on a usable program converges (no re-execution)", async () => {
    const { service, calls } = buildService();
    const programId = await submitCompileTest(service);
    expect(calls).toHaveLength(2);
    const program = await service.testProgram(
      programId,
      ACTOR,
      "00000000-0000-7000-8000-0000000000e9",
    );
    expect(program.status).toBe("usable");
    expect(calls).toHaveLength(2); // NO further executions
  });

  test("testing requires the validated state", async () => {
    const { service } = buildService();
    const outcome = await service.submitProgram(
      {
        source: GOOD_SOURCE,
        language: "javascript",
        contract: contract(),
        testCases: TEST_CASES,
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "key-1",
      ACTOR,
    );
    if (outcome.status === "rejected") throw new Error(outcome.reason);
    await expect(
      service.testProgram(outcome.program.id, ACTOR, "00000000-0000-7000-8000-0000000000e9"),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

describe("binding + invocation (the SAME registry and admission chain)", () => {
  test("a usable program binds into the tool registry and resolves", async () => {
    const { service, registry } = buildService();
    const programId = await submitCompileTest(service);
    const outcome = await service.bindTool(programId, ACTOR);
    expect(outcome.status).toBe("registered");
    const resolved = await registry.resolve("synth-doubler");
    expect(resolved).not.toBeNull();
    expect(resolved?.contract.toolId).toBe("synth-doubler");
    // Identical re-binding converges (registry arbitration).
    const again = await service.bindTool(programId, ACTOR);
    expect(again.status).toBe("converged");
  });

  test("binding a non-usable program fails closed", async () => {
    const { service } = buildService();
    const programId = await submitCompileTest(service, GOOD_SOURCE, "skip-tests");
    await expect(service.bindTool(programId, ACTOR)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  test("the bound adapter executes through the executor and returns the observation", async () => {
    const { service, registry, calls } = buildService();
    const programId = await submitCompileTest(service);
    await service.bindTool(programId, ACTOR);
    const resolved = await registry.resolve("synth-doubler");
    if (resolved === null) throw new Error("not registered");
    const observation = await resolved.adapter.execute(
      {
        invocationId: "00000000-0000-7000-8000-0000000000i1",
        contract: resolved.contract,
        input: { value: 21 },
      },
      {
        tenantId: ACTOR.tenantId,
        applicationId: ACTOR.applicationId,
        executionId: "00000000-0000-7000-8000-0000000000e9",
        timeoutMs: 5000,
      },
    );
    expect(observation.kind).toBe("tool-success");
    if (observation.kind === "tool-success") {
      expect(observation.output).toEqual({ doubled: 42 });
    }
    expect(calls).toHaveLength(3); // 2 test cases + 1 invocation
  });

  test("a retired program's adapter fails closed at dispatch", async () => {
    const { service, registry } = buildService();
    const programId = await submitCompileTest(service);
    await service.bindTool(programId, ACTOR);
    const resolved = await registry.resolve("synth-doubler");
    if (resolved === null) throw new Error("not registered");
    await service.retireProgram(programId, ACTOR);
    const observation = await resolved.adapter.execute(
      {
        invocationId: "00000000-0000-7000-8000-0000000000i2",
        contract: resolved.contract,
        input: { value: 2 },
      },
      {
        tenantId: ACTOR.tenantId,
        applicationId: ACTOR.applicationId,
        executionId: "00000000-0000-7000-8000-0000000000e9",
        timeoutMs: 5000,
      },
    );
    expect(observation.kind).toBe("tool-failure");
    if (observation.kind === "tool-failure") {
      expect(observation.failure.failureClass).toBe("tool-execution");
      expect(observation.failure.message).toContain("no longer usable");
    }
  });

  test("retirement requires the usable state", async () => {
    const { service } = buildService();
    const programId = await submitCompileTest(service, GOOD_SOURCE, "skip-tests");
    await expect(service.retireProgram(programId, ACTOR)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });
});

describe("the fact projection (learning input, origin-segregated)", () => {
  test("usable + unexpired programs project synthesized facts", async () => {
    const { service } = buildService();
    await submitCompileTest(service);
    const facts = await service.synthesizedFacts(ACTOR.applicationId);
    expect(facts).toHaveLength(1);
    const fact = facts[0] as Record<string, unknown>;
    expect(fact.toolId).toBe("synth-doubler");
    expect(fact.origin).toBe("synthesized");
    expect(fact.capabilityIds).toEqual(["arithmetic"]);
    expect(fact.inputFields).toEqual([{ name: "value", type: "number", required: true }]);
    expect(typeof fact.sourceDigest).toBe("string");
  });

  test("non-usable programs project nothing", async () => {
    const { service } = buildService();
    await submitCompileTest(service, GOOD_SOURCE, "skip-tests");
    expect(await service.synthesizedFacts(ACTOR.applicationId)).toHaveLength(0);
  });
});
