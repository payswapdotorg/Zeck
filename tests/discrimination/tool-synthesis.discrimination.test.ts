/**
 * Discrimination: the tool-synthesis boundaries (WORK-018, TOL-004;
 * checkpoint contracts SELF-HOSTING-BOUNDARY, IDENTITY-IDEMPOTENCY,
 * CONCURRENCY-CRASH-SAFETY, IMPLEMENTATION-COMPLETENESS).
 *
 * Every protection is proven by a mutant that removes it (the
 * WORK-013/014/017 red-record pattern): STATIC mutants mutate the
 * REAL source in memory and the shared scanners must flag exactly
 * the weakened protection (the architecture gate runs the same rules
 * over the real tree, so it FAILS under exactly these mutations);
 * RUNTIME red records observe the governed world under constructed
 * wiring scenarios.
 *
 * The mandatory mutants (TS = tool synthesis):
 *
 *   TS1  direct process execution appears in tools — static
 *        (execution-surface scanner);
 *   TS2  dynamic evaluation appears in tools — static;
 *   TS3  the executor stops wrapping the sandbox manager — static
 *        (sandbox-public import/dispatch removed);
 *   TS4  a SECOND executor implementation appears — static;
 *   TS5  the service deps gain an authority seam — static;
 *   TS6  the service deps drop the sandbox executor (bypass wiring) —
 *        static (the pinned set is exact);
 *   TS7  the lifecycle vocabulary leaks outside tools — static;
 *   TS8  (runtime) a program failing STATIC validation can never
 *        become usable (rejected terminal, no bind);
 *   TS9  (runtime) a program failing RUNTIME TESTS can never become
 *        usable (rejected terminal with per-case evidence);
 *   TS10 (runtime) substrate confinement: a program declaring an
 *        un-granted network host is refused BEFORE dispatch — no
 *        sandbox row is ever created;
 *   TS11 (runtime) substrate confinement: a program declaring an
 *        un-mediated secret reference is refused before dispatch;
 *   TS12 (runtime) ephemerality: an expired program cannot bind
 *        (EXPIRED) even from usable; the adapter fails closed past
 *        expiry;
 *   TS13 (runtime) single registry: binding lands in THE tool
 *        registry (no second synthesis registry exists — the barrel
 *        exposes exactly one binding surface);
 *   TS14 (runtime) idempotency: a reused submission key with a
 *        different fingerprint fails IDEMPOTENCY_KEY_REUSED.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  ComputeEnvironmentRecord,
  ComputeEnvironmentSpec,
} from "../../src/modules/sandbox/public";
import {
  createEnvironmentCatalog,
  createSandboxProviderRegistry,
  createSandboxService,
  InMemorySandboxStore,
} from "../../src/modules/sandbox/public";
import type {
  SynthesisSandboxDispatch,
  SynthesisSandboxExecutor,
  SynthesisService,
  ToolContract,
} from "../../src/modules/tools/public";
import {
  confinementCheck,
  createSynthesisSandboxExecutor,
  createSynthesisService,
  createSynthesizedAdapterFactory,
  createToolRegistry,
  InMemorySynthesisStore,
} from "../../src/modules/tools/public";
import {
  executionSurfaceViolations,
  executorImplementationViolations,
  lifecycleVocabularyViolations,
  synthesisDepsViolations,
} from "./lib/tool-synthesis";

const REPO_ROOT = join(process.cwd());
const TOOLS_DIR = join(REPO_ROOT, "src/modules/tools");
const MODULES_DIR = join(REPO_ROOT, "src/modules");

interface FileLike {
  readonly path: string;
  readonly content: string;
}

function collectFiles(dir: string): FileLike[] {
  const out: FileLike[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push({ path: full.slice(REPO_ROOT.length + 1), content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

const TOOLS_TREE = collectFiles(TOOLS_DIR);
const MODULES_TREE = collectFiles(MODULES_DIR);
const SERVICE_SOURCE = readFileSync(join(TOOLS_DIR, "application/synthesis-service.ts"), "utf8");

function withMutation(
  tree: readonly FileLike[],
  path: string,
  mutation: (content: string) => string,
): FileLike[] {
  return tree.map((file) =>
    file.path === path ? { path, content: mutation(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// The runtime world (shared by the runtime red records).
// ---------------------------------------------------------------------------

const ACTOR = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
};
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000d9";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

/** A process environment spec that grants nothing (pure compute). */
const CLOSED_PROCESS_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 5000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

/** An executor double that records calls and doubles values. */
function recordingExecutor(): {
  executor: SynthesisSandboxExecutor;
  calls: SynthesisSandboxDispatch[];
} {
  const calls: SynthesisSandboxDispatch[] = [];
  return {
    calls,
    executor: {
      async execute(dispatch) {
        calls.push(dispatch);
        const value = (dispatch.input as { value: number }).value;
        return {
          outcome: "success",
          stdout: JSON.stringify({ doubled: value * 2 }),
          outputDigest: null,
          durationMs: 1,
          sandboxId: "00000000-0000-7000-8000-0000000000f9",
        };
      },
    },
  };
}

function buildWorld(): {
  service: SynthesisService;
  store: InMemorySynthesisStore;
  registry: ReturnType<typeof createToolRegistry>;
  calls: SynthesisSandboxDispatch[];
} {
  const store = new InMemorySynthesisStore();
  const { executor, calls } = recordingExecutor();
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

function contract(overrides: Partial<ToolContract> = {}): ToolContract {
  return {
    toolId: "synth-doubler",
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
    ...overrides,
  };
}

const TEST_CASES = [{ name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } }];

async function submitAndCompile(
  service: SynthesisService,
  source: string,
  toolContract: ToolContract,
): Promise<string> {
  const outcome = await service.submitProgram(
    {
      source,
      language: "javascript",
      contract: toolContract,
      testCases: TEST_CASES,
      expiresAt: "2099-01-01T00:00:00Z",
    },
    `key-${Math.random().toString(36).slice(2)}`,
    ACTOR,
  );
  if (outcome.status === "rejected") throw new Error(outcome.reason);
  const programId = outcome.program.id;
  const compiled = await service.compileProgram(programId, ACTOR);
  if (compiled.status === "rejected") {
    throw new Error(`compile rejected: ${compiled.rejection?.reason}`);
  }
  return programId;
}

// ---------------------------------------------------------------------------
// Static mutants (the shared scanners must flag exactly the weakening).
// ---------------------------------------------------------------------------

describe("discrimination: tool synthesis (WORK-018, TOL-004)", () => {
  test("TS1: a direct process-execution surface appearing in tools is flagged", () => {
    const mutated = withMutation(
      TOOLS_TREE,
      "src/modules/tools/application/synthesis-service.ts",
      (c) => c.replace("return {", "const child = spawn(cmd, args); return {"),
    );
    const violations = executionSurfaceViolations(mutated);
    expect(violations.some((v) => v.includes("synthesis-service.ts") && v.includes("spawn"))).toBe(
      true,
    );
    // The clean tree has none.
    expect(executionSurfaceViolations(TOOLS_TREE)).toEqual([]);
  });

  test("TS2: dynamic evaluation appearing in tools is flagged", () => {
    const mutated = withMutation(TOOLS_TREE, "src/modules/tools/domain/synthesis.ts", (c) =>
      c.replace(
        "export const SYNTHESIS_FORBIDDEN_SOURCE_TOKENS",
        "const evil = eval(source); export const SYNTHESIS_FORBIDDEN_SOURCE_TOKENS",
      ),
    );
    const violations = executionSurfaceViolations(mutated);
    expect(violations.some((v) => v.includes("synthesis.ts") && v.includes("eval"))).toBe(true);
  });

  test("TS3: the executor no longer wrapping the sandbox manager is flagged", () => {
    const mutated = withMutation(
      TOOLS_TREE,
      "src/modules/tools/adapters/synthesis-sandbox-executor.ts",
      (c) => c.replace('from "../../sandbox/public"', 'from "../../executions/public"'),
    );
    expect(executorImplementationViolations(mutated)).toContain(
      "src/modules/tools/adapters/synthesis-sandbox-executor.ts: sandbox-public import removed",
    );
    const noDispatch = withMutation(
      TOOLS_TREE,
      "src/modules/tools/adapters/synthesis-sandbox-executor.ts",
      (c) => c.replace("dispatchSandboxExecution", "dispatchSomethingElse"),
    );
    expect(
      executorImplementationViolations(noDispatch).some((v) => v.includes("dispatch path removed")),
    ).toBe(true);
    expect(executorImplementationViolations(TOOLS_TREE)).toEqual([]);
  });

  test("TS4: a SECOND executor implementation appearing is flagged", () => {
    const mutated = [
      ...TOOLS_TREE,
      {
        path: "src/modules/tools/adapters/local-synth-executor.ts",
        content:
          "import type { SynthesisSandboxDispatch, SynthesisSandboxResult, SynthesisSandboxExecutor } from '../ports/synthesis-sandbox';\nexport class LocalSynthExecutor implements SynthesisSandboxExecutor {\n  async execute(dispatch: SynthesisSandboxDispatch): Promise<SynthesisSandboxResult> { return { outcome: 'success', stdout: '{}', outputDigest: null, durationMs: 0, sandboxId: 'x' }; }\n}\n",
      },
    ];
    const violations = executorImplementationViolations(mutated);
    expect(violations).toContain(
      "src/modules/tools/adapters/local-synth-executor.ts: a second executor implementation",
    );
  });

  test("TS5: the service deps gaining an authority seam is flagged", () => {
    const mutated = SERVICE_SOURCE.replace(
      "readonly store: SynthesisStore;",
      "readonly store: SynthesisStore;\n  readonly admission: ToolAdmission;",
    );
    const violations = synthesisDepsViolations(mutated);
    expect(violations.some((v) => v.includes("ToolAdmission"))).toBe(true);
    expect(synthesisDepsViolations(SERVICE_SOURCE)).toEqual([]);
  });

  test("TS6: the service deps dropping the sandbox executor (bypass wiring) is flagged", () => {
    const mutated = SERVICE_SOURCE.replace("readonly sandbox: SynthesisSandboxExecutor;", "");
    const violations = synthesisDepsViolations(mutated);
    expect(violations.some((v) => v.includes("pinned set"))).toBe(true);
  });

  test("TS7: the lifecycle vocabulary leaking outside tools is flagged", () => {
    const mutated = [
      ...MODULES_TREE,
      {
        path: "src/modules/executions/domain/synth-leak.ts",
        content: "export interface SynthesizedProgramRecord { status: string; }",
      },
    ];
    const violations = lifecycleVocabularyViolations(mutated);
    expect(violations).toContain(
      "src/modules/executions/domain/synth-leak.ts: synthesized-program vocabulary leaked",
    );
    expect(lifecycleVocabularyViolations(MODULES_TREE)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Runtime red records.
  // -------------------------------------------------------------------------

  test("TS8: a program failing STATIC validation never becomes usable (rejected terminal)", async () => {
    const { service, registry } = buildWorld();
    // The static gate rejects the forbidden token at compile.
    const outcome = await service.submitProgram(
      {
        source: "const t = setTimeout(f, 1);",
        language: "javascript",
        contract: contract(),
        testCases: TEST_CASES,
        expiresAt: "2099-01-01T00:00:00Z",
      },
      "key-static-fail",
      ACTOR,
    );
    if (outcome.status === "rejected") throw new Error(outcome.reason);
    const program = await service.compileProgram(outcome.program.id, ACTOR);
    expect(program.status).toBe("rejected");
    expect(program.rejection?.phase).toBe("static-validation");
    // Terminal: no test, no bind, no registry entry.
    await expect(service.testProgram(program.id, ACTOR, EXECUTION_ID)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    await expect(service.bindTool(program.id, ACTOR)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(await registry.resolve("synth-doubler")).toBeNull();
  });

  test("TS9: a program failing RUNTIME TESTS never becomes usable (per-case evidence)", async () => {
    const store = new InMemorySynthesisStore();
    // An executor that always fails: the runtime-test gate must reject.
    const failing: SynthesisSandboxExecutor = {
      async execute() {
        return {
          outcome: "failure",
          failureClass: "sandbox-execution",
          message: "boom",
          sandboxId: null,
        };
      },
    };
    const registry = createToolRegistry();
    const service = createSynthesisService({
      store,
      sandbox: failing,
      registry,
      adapterFactory: createSynthesizedAdapterFactory({
        sandbox: failing,
        store,
        now: () => new Date("2026-01-01T00:00:00Z"),
      }),
      digest,
      generateId: () => "00000000-0000-7000-8000-0000000000fa",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const programId = await submitAndCompile(service, "const x = 1;", contract());
    const program = await service.testProgram(programId, ACTOR, EXECUTION_ID);
    expect(program.status).toBe("rejected");
    expect(program.rejection?.phase).toBe("runtime-tests");
    expect(program.runtimeTests?.passed).toBe(false);
    await expect(service.bindTool(programId, ACTOR)).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
    expect(await registry.resolve("synth-doubler")).toBeNull();
  });

  test("TS10: substrate confinement — an un-granted network host is refused BEFORE any sandbox row", async () => {
    // The REAL sandbox service + environment catalog (in-memory store,
    // no providers needed: the refusal happens before dispatch).
    const store = new InMemorySandboxStore();
    const catalog = createEnvironmentCatalog({
      store,
      generateId: () => "00000000-0000-7000-8000-0000000000ff",
      now: () => new Date("2026-01-01T00:00:00Z"),
      hashSpec: (canonical) => createHash("sha256").update(canonical).digest("hex"),
    });
    // A ledger stub that FAILS if ever reached: the confinement refusal
    // happens BEFORE admission, so nothing may touch the execution
    // ledger (the red record proves the pre-dispatch ordering).
    const unreachableLedger = {
      async recordStepEvent(): Promise<never> {
        throw new Error("the ledger must never be reached: confinement refuses before dispatch");
      },
      async getExecution(): Promise<never> {
        throw new Error("the ledger must never be reached: confinement refuses before dispatch");
      },
    };
    const service = createSandboxService({
      store,
      admission: {
        async admit() {
          return { allowed: true as const };
        },
      },
      capabilities: {
        async resolve() {
          return {
            satisfied: true as const,
            catalogRevision: "seed-revision",
            satisfactions: [
              {
                requirementId: "process-sandbox",
                claimId: "process-sandbox",
                claimKind: "runtime" as const,
                claimVersion: "1.0.0",
                evidenceKind: "adapter-declared" as const,
                evidenceReference: "seed",
                publisher: "seed",
              },
            ],
          };
        },
      },
      ledger: unreachableLedger,
      providers: createSandboxProviderRegistry(),
      generateId: () => "00000000-0000-7000-8000-0000000000fb",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const environment = await catalog.register(
      {
        applicationId: ACTOR.applicationId,
        tenantId: ACTOR.tenantId,
        slug: "synth-env",
        name: "Synthesis environment",
        spec: CLOSED_PROCESS_SPEC,
      },
      "env-key",
      ACTOR,
    );

    const executor = createSynthesisSandboxExecutor({
      service,
      catalog,
      options: { environmentId: environment.id, runnerCommand: "/usr/bin/node" },
    });

    // The program DECLARES an allowlisted host the environment does not
    // grant: the executor must refuse before dispatch (no sandbox row).
    const declaring: ToolContract = contract({
      network: { egress: "allowlist", hosts: ["api.example.internal"] },
      sideEffect: "write-external",
      execution: { deterministic: false, timeoutMs: 5000, idempotent: false },
    });
    // The pure confinement verdict (the closed environment grants no
    // egress at all — the mode-level refusal).
    const pure = confinementCheck(declaring, environment as ComputeEnvironmentRecord);
    expect(pure.confined).toBe(false);
    if (!pure.confined) {
      expect(pure.reason).toContain("grants none");
    }
    // The host-level refusal: an environment that DOES allowlist a
    // DIFFERENT host still refuses the undeclared one.
    const otherHostEnv = {
      ...environment,
      spec: {
        ...environment.spec,
        network: { egress: "allowlist" as const, allowedHosts: ["api.other.internal"] },
      },
    };
    const hostLevel = confinementCheck(declaring, otherHostEnv as ComputeEnvironmentRecord);
    expect(hostLevel.confined).toBe(false);
    if (!hostLevel.confined) {
      expect(hostLevel.reason).toContain("api.example.internal");
    }
    // And the wired executor refuses BEFORE any durable sandbox row.
    await expect(
      executor.execute({
        program: {
          toolId: "synth-doubler",
          version: "1.0.0",
          sourceDigest: "d",
          source: "const x = 1;",
        },
        contract: declaring,
        input: { value: 2 },
        actor: ACTOR,
        executionId: EXECUTION_ID,
        idempotencyKey: "synth-confine-1",
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(await store.listSandboxesByExecution(ACTOR.applicationId, EXECUTION_ID)).toHaveLength(0);
  });

  test("TS11: substrate confinement — an un-mediated secret reference is refused before dispatch", async () => {
    const store = new InMemorySandboxStore();
    const catalog = createEnvironmentCatalog({
      store,
      generateId: () => "00000000-0000-7000-8000-0000000000ff",
      now: () => new Date("2026-01-01T00:00:00Z"),
      hashSpec: (canonical) => createHash("sha256").update(canonical).digest("hex"),
    });
    const environment = await catalog.register(
      {
        applicationId: ACTOR.applicationId,
        tenantId: ACTOR.tenantId,
        slug: "synth-env",
        name: "Synthesis environment",
        spec: CLOSED_PROCESS_SPEC,
      },
      "env-key",
      ACTOR,
    );
    const declaring: ToolContract = contract({
      secrets: { access: "allowlist", refs: ["vault/secret-xyz"] },
    });
    const verdict = confinementCheck(declaring, environment);
    expect(verdict.confined).toBe(false);
    if (!verdict.confined) {
      expect(verdict.reason).toContain("vault/secret-xyz");
    }
  });

  test("TS12: ephemerality — an expired program cannot bind and the adapter fails closed", async () => {
    const store = new InMemorySynthesisStore();
    const { executor, calls } = recordingExecutor();
    const registry = createToolRegistry();
    // A clock at 2026-01-01; the program expires at 2026-01-02.
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
      generateId: () => "00000000-0000-7000-8000-0000000000fc",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const outcome = await service.submitProgram(
      {
        source: "const x = 1;",
        language: "javascript",
        contract: contract(),
        testCases: TEST_CASES,
        expiresAt: "2026-01-02T00:00:00Z",
      },
      "key-expiry",
      ACTOR,
    );
    if (outcome.status === "rejected") throw new Error(outcome.reason);
    const programId = outcome.program.id;
    await service.compileProgram(programId, ACTOR);
    await service.testProgram(programId, ACTOR, EXECUTION_ID);
    // Bind succeeds BEFORE expiry, then the adapter fails closed AFTER it.
    const bound = await service.bindTool(programId, ACTOR);
    expect(bound.status).toBe("registered");
    const resolved = await registry.resolve("synth-doubler");
    if (resolved === null) throw new Error("not registered");
    const late = await resolved.adapter.execute(
      {
        invocationId: "00000000-0000-7000-8000-0000000000fd",
        contract: resolved.contract,
        input: { value: 2 },
      },
      {
        tenantId: ACTOR.tenantId,
        applicationId: ACTOR.applicationId,
        executionId: EXECUTION_ID,
        timeoutMs: 5000,
      },
    );
    expect(late.kind).toBe("tool-success");
    // A FROZEN late clock (past expiry): the adapter must fail closed.
    const lateFactory = createSynthesizedAdapterFactory({
      sandbox: executor,
      store,
      now: () => new Date("2026-01-03T00:00:00Z"),
    });
    const usableProgram = await service.getProgram(ACTOR.applicationId, programId);
    if (usableProgram === null) throw new Error("program missing");
    const lateAdapter = lateFactory.create(usableProgram, 5000);
    const observation = await lateAdapter.execute(
      {
        invocationId: "00000000-0000-7000-8000-0000000000fe",
        contract: contract(),
        input: { value: 2 },
      },
      {
        tenantId: ACTOR.tenantId,
        applicationId: ACTOR.applicationId,
        executionId: EXECUTION_ID,
        timeoutMs: 5000,
      },
    );
    expect(observation.kind).toBe("tool-failure");
    if (observation.kind === "tool-failure") {
      expect(observation.failure.message).toContain("expired");
    }
    // And no execution happened through the executor for the expired call.
    expect(calls).toHaveLength(2); // two test cases + one successful invocation only
  });

  test("TS13: binding lands in THE tool registry (no second synthesis registry)", async () => {
    const { service, registry } = buildWorld();
    const programId = await submitAndCompile(service, "const x = 1;", contract());
    await service.testProgram(programId, ACTOR, EXECUTION_ID);
    const bound = await service.bindTool(programId, ACTOR);
    expect(bound.status).toBe("registered");
    // The ONE registry resolves the synthesized tool alongside built-ins.
    const resolved = await registry.resolve("synth-doubler");
    expect(resolved?.contract.toolId).toBe("synth-doubler");
    // The barrel exposes exactly one registry factory + one binding surface.
    const barrel = readFileSync(join(TOOLS_DIR, "public.ts"), "utf8");
    expect(barrel.match(/createToolRegistry/g)?.length).toBeGreaterThan(0);
    expect(barrel.includes("createSynthesisService")).toBe(true);
  });

  test("TS14: idempotency — a reused submission key with a different fingerprint fails closed", async () => {
    const { service } = buildWorld();
    const base = {
      language: "javascript",
      contract: contract(),
      testCases: TEST_CASES,
      expiresAt: "2099-01-01T00:00:00Z",
    } as const;
    await service.submitProgram({ ...base, source: "const a = 1;" }, "key-reuse", ACTOR);
    await expect(
      service.submitProgram({ ...base, source: "const b = 2;" }, "key-reuse", ACTOR),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
});
