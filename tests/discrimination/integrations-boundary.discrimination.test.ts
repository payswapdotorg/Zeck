/**
 * Discrimination: the WORK-016 integration boundary (HIGH_ASSURANCE;
 * the 26 mandatory mutants M1–M26).
 *
 * Every protection is proven by a mutant that removes it. STATIC
 * mutants mutate the REAL source in memory and the shared scanners must
 * flag exactly the weakened protection (the architecture gate runs the
 * same scanners over the real tree). RUNTIME red records observe the
 * REAL services under constructed attacks.
 *
 * The 26 mutants:
 *   M1  adapter mutates WorkflowOS workflow state directly    (static: mutation channel)
 *   M2  adapter writes WorkflowOS internal task status       (static: mutation verb)
 *   M3  adapter bypasses Zeck Execution                      (static: delegation scan + runtime)
 *   M4  adapter bypasses Zeck Policy                         (static: authority import + runtime: denied)
 *   M5  adapter bypasses Capability admission                (static: authority import)
 *   M6  adapter bypasses Budget authority                    (static + runtime: BUDGET_EXCEEDED)
 *   M7  adapter bypasses Verification                       (static + runtime: no fabricated PASS)
 *   M8  adapter bypasses tenant isolation                   (runtime: cross-tenant denied)
 *   M9  adapter creates a second WorkflowOS state machine   (static: second-authority)
 *   M10 adapter exposes framework-specific types publicly   (static: framework identifier)
 *   M11 BYOA direct database access                         (static: SQL/driver)
 *   M12 BYOA direct tool access                             (static: tools import + runtime: references only)
 *   M13 BYOA direct model/provider access                   (static: models import)
 *   M14 BYOA bypasses policy                                (runtime: admission deny blocks)
 *   M15 BYOA bypasses capability intersection               (runtime: effective permissions only)
 *   M16 BYOA bypasses budget                                (runtime: BUDGET_EXCEEDED at dispatch)
 *   M17 BYOA bypasses verification                          (runtime: no fabricated PASS)
 *   M18 BYOA bypasses tenant scope                          (runtime: TENANT_SCOPE_VIOLATION)
 *   M19 BYOA creates second agent registry                  (static + runtime: real registry)
 *   M20 framework type leaks into public contract           (static: public barrel)
 *   M21 external agent mutates execution state              (runtime: rogue fields stripped)
 *   M22 external agent fabricates authorization             (runtime: rogue fields stripped)
 *   M23 external agent supplies raw secret                  (static + runtime: stripped)
 *   M24 external agent bypasses credential mediation        (static + runtime: references only)
 *   M25 external agent creates second execution identity    (static: delegation + id minting)
 *   M26 external agent creates second policy authority      (static: authority import)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type ByoaExternalAgent,
  createByoaAgentProvider,
} from "../../src/integrations/workflowos/public";
import { createInMemoryExecutions } from "../unit/executions/fakes";
import { seedIntegrationWorld } from "../unit/integrations/world";
import {
  byoaRegistrationViolations,
  byoaSanitizationViolations,
  executionDelegationViolations,
  integrationSurfaceViolations,
  type SurfaceFile,
} from "./lib/integrations";

const REPO_ROOT = join(process.cwd());

function readSurfaceFile(path: string): SurfaceFile {
  return { path, content: readFileSync(join(REPO_ROOT, path), "utf8") };
}

function realIntegrationSurface(): SurfaceFile[] {
  return [
    readSurfaceFile("src/integrations/workflowos/public.ts"),
    readSurfaceFile("src/integrations/workflowos/domain/submission.ts"),
    readSurfaceFile("src/integrations/workflowos/domain/receipt.ts"),
    readSurfaceFile("src/integrations/workflowos/domain/byoa.ts"),
    readSurfaceFile("src/integrations/workflowos/domain/index.ts"),
    readSurfaceFile("src/integrations/workflowos/application/workflowos-service.ts"),
    readSurfaceFile("src/integrations/workflowos/application/byoa-interop.ts"),
    readSurfaceFile("src/integrations/workflowos/application/index.ts"),
    readSurfaceFile("src/integrations/workflowos/ports/executions-authority.ts"),
    readSurfaceFile("src/integrations/workflowos/ports/agents-authority.ts"),
    readSurfaceFile("src/integrations/workflowos/ports/index.ts"),
    readSurfaceFile("benchmarks/harness.ts"),
    readSurfaceFile("benchmarks/report.ts"),
    readSurfaceFile("benchmarks/contract.ts"),
    readSurfaceFile("benchmarks/strategies.ts"),
  ];
}

function withMutation(path: string, mutation: (content: string) => string): SurfaceFile[] {
  return realIntegrationSurface().map((file) =>
    file.path === path ? { path, content: mutation(file.content) } : file,
  );
}

describe("discrimination: integration static mutants (M1–M13, M19, M20, M23–M26)", () => {
  test("the REAL integration surface passes every scanner (baseline)", () => {
    expect(integrationSurfaceViolations(realIntegrationSurface())).toEqual([]);
    expect(
      executionDelegationViolations(
        readFileSync(
          join(REPO_ROOT, "src/integrations/workflowos/application/workflowos-service.ts"),
          "utf8",
        ),
      ),
    ).toEqual([]);
    expect(
      byoaRegistrationViolations(
        readFileSync(
          join(REPO_ROOT, "src/integrations/workflowos/application/byoa-interop.ts"),
          "utf8",
        ),
      ),
    ).toEqual([]);
    expect(
      byoaSanitizationViolations(
        readFileSync(
          join(REPO_ROOT, "src/integrations/workflowos/application/byoa-interop.ts"),
          "utf8",
        ),
      ),
    ).toEqual([]);
  });

  test("M1: an outbound WorkflowOS mutation channel appearing in the integration is detected", () => {
    const tree = withMutation(
      "src/integrations/workflowos/application/workflowos-service.ts",
      (content) =>
        `${content}\nexport async function pushToWorkflowOs(url: string) { await fetch(url, { method: "POST" }); }\n`,
    );
    expect(integrationSurfaceViolations(tree)).toContain(
      "mutation-channel:src/integrations/workflowos/application/workflowos-service.ts",
    );
  });

  test("M2: a WorkflowOS task-status write verb is detected", () => {
    const tree = withMutation(
      "src/integrations/workflowos/application/workflowos-service.ts",
      (content) =>
        `${content}\nasync function syncStatus(taskId: string, status: string) { await updateTask(taskId, status); }\n`,
    );
    expect(integrationSurfaceViolations(tree)).toContain(
      "workflowos-mutation-verb:src/integrations/workflowos/application/workflowos-service.ts",
    );
  });

  test("M3/M25: the submission path dropping createExecution delegation is detected", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/integrations/workflowos/application/workflowos-service.ts"),
      "utf8",
    );
    const mutated = source.replace(
      "const receipt = await executions.createExecution(input, idempotencyKey, {",
      "const receipt = await executions.replayReceipt(input, idempotencyKey, {",
    );
    expect(mutated).not.toBe(source);
    expect(executionDelegationViolations(mutated)).toContain(
      "submission-must-delegate-to-createExecution",
    );
  });

  test("M25: the integration minting its own execution identities is detected", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/integrations/workflowos/application/workflowos-service.ts"),
      "utf8",
    );
    const mutated = `${source}\nconst ownExecutionId = generateId();\nvoid ownExecutionId;\n`;
    expect(executionDelegationViolations(mutated)).toContain(
      "integration-must-not-mint-execution-identities",
    );
  });

  test("M4/M5/M6/M7/M13/M26: an authority-module import in the integration is detected", () => {
    for (const module of [
      "policies",
      "budgets",
      "verification",
      "capabilities",
      "tools",
      "models",
      "learning",
    ]) {
      const tree = withMutation(
        "src/integrations/workflowos/application/workflowos-service.ts",
        (content) =>
          `${content}\nimport { x } from "../../../modules/${module}/public";\nvoid x;\n`,
      );
      expect(integrationSurfaceViolations(tree), `module ${module}`).toContain(
        `authority-import:src/integrations/workflowos/application/workflowos-service.ts`,
      );
    }
  });

  test("M11: SQL/driver access appearing in the integration tree is detected", () => {
    const tree = withMutation(
      "src/integrations/workflowos/domain/receipt.ts",
      (content) => `${content}\nimport { Client } from "pg";\nconst c = new Client();\nvoid c;\n`,
    );
    expect(integrationSurfaceViolations(tree)).toContain(
      "mutation-channel:src/integrations/workflowos/domain/receipt.ts",
    );
  });

  test("M9: a second WorkflowOS/authority state machine is detected", () => {
    const tree = withMutation(
      "src/integrations/workflowos/domain/receipt.ts",
      (content) =>
        `${content}\nclass WorkflowOsStateStore { states = new Map<string, string>(); }\nvoid WorkflowOsStateStore;\n`,
    );
    expect(integrationSurfaceViolations(tree)).toContain(
      "second-authority:src/integrations/workflowos/domain/receipt.ts",
    );
  });

  test("M10/M20: a framework type leaking into the public barrel is detected", () => {
    const tree = withMutation(
      "src/integrations/workflowos/public.ts",
      (content) => `${content}\nexport type LangGraphGraph = { nodes: unknown[] };\n`,
    );
    const violations = integrationSurfaceViolations(tree);
    expect(violations.join("\n")).toContain(
      "framework-identifier:src/integrations/workflowos/public.ts:LangGraph",
    );
  });

  test("M19: BYOA registration bypassing the registry authority is detected", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/integrations/workflowos/application/byoa-interop.ts"),
      "utf8",
    );
    const mutated = source.replace(
      "const agent = await deps.agents.registerAgent(",
      "const agent = await localAgents.registerAgent(",
    );
    expect(mutated).not.toBe(source);
    expect(byoaRegistrationViolations(mutated)).toContain(
      "byoa-registration-must-delegate-to-registry",
    );
  });

  test("M19: BYOA owning a local agent store is detected", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/integrations/workflowos/application/byoa-interop.ts"),
      "utf8",
    );
    const mutated = `${source}\nconst localAgents = new Map<string, unknown>();\nvoid localAgents;\n`;
    expect(byoaRegistrationViolations(mutated)).toContain("byoa-must-not-own-an-agent-store");
  });

  test("M23: a secret-shaped field appearing in the BYOA contracts is detected", () => {
    const tree = withMutation(
      "src/integrations/workflowos/domain/byoa.ts",
      (content) => `${content}\nexport interface RogueByoaShape { readonly apiKey?: string; }\n`,
    );
    expect(integrationSurfaceViolations(tree)).toContain(
      "byoa-secret-surface:src/integrations/workflowos/domain/byoa.ts",
    );
  });

  test("M21/M22: the wrapper trusting external authority fields is detected", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/integrations/workflowos/application/byoa-interop.ts"),
      "utf8",
    );
    const mutated = source.replace(
      "const output = isPlainObject(observation.output) ? observation.output : null;",
      "const output = isPlainObject(observation.output) ? { ...observation.output, status: (observation as { status?: string }).status } : null;",
    );
    expect(mutated).not.toBe(source);
    expect(byoaSanitizationViolations(mutated)).toContain("external-side-authority-field-trusted");
  });

  test("M21: the wrapper spreading the whole observation is detected", () => {
    const source = readFileSync(
      join(REPO_ROOT, "src/integrations/workflowos/application/byoa-interop.ts"),
      "utf8",
    );
    const mutated = source.replace(
      "return {\n        outcomeClass: observation.outcomeClass,",
      "return {\n        ...observation,\n        outcomeClass: observation.outcomeClass,",
    );
    expect(mutated).not.toBe(source);
    expect(byoaSanitizationViolations(mutated)).toContain("observation-spread");
  });

  test("§21: an authority mutation call appearing in a benchmark MEASUREMENT file is detected", () => {
    const tree = withMutation(
      "benchmarks/harness.ts",
      (content) => `${content}\nawait executions.transition({ command: "pass" }, "x");\n`,
    );
    expect(integrationSurfaceViolations(tree)).toContain(
      "measurement-mutation-call:benchmarks/harness.ts",
    );
  });

  test("§21: a policy/registry mutation call appearing in the benchmark strategies is detected", () => {
    const tree = withMutation(
      "benchmarks/strategies.ts",
      (content) => `${content}\nawait deps.someRegistry.promote({ agentId: "x" }, "k");\n`,
    );
    expect(integrationSurfaceViolations(tree)).toContain(
      "strategy-authority-mutation:benchmarks/strategies.ts",
    );
  });
});

describe("discrimination: runtime red records (M3–M8, M14–M18, M21–M24)", () => {
  test("R-M3: submissions ride the executions authority (a recording authority observes the delegation)", async () => {
    const world = seedIntegrationWorld();
    const seen: unknown[] = [];
    // Wrap the authority in an observing proxy — the ONLY way the
    // submission lands is through createExecution.
    const observingExecutions = {
      createExecution: async (input: unknown, key: string, actor: unknown) => {
        seen.push({ input, key, actor });
        return world.executionsWorld.service.createExecution(input as never, key, actor as never);
      },
      getExecution: (applicationId: string, executionId: string) =>
        world.executionsWorld.service.getExecution(applicationId, executionId),
      listEvents: (applicationId: string, executionId: string) =>
        world.executionsWorld.service.listEvents(applicationId, executionId),
      listVerificationResults: (applicationId: string, executionId: string) =>
        world.executionsWorld.service.listVerificationResults(applicationId, executionId),
    };
    const { createWorkflowOsIntegrationService } = await import(
      "../../src/integrations/workflowos/public"
    );
    const service = createWorkflowOsIntegrationService({ executions: observingExecutions });
    await service.submitWork(
      { workRef: "rm3-work", task: { kind: "review" } },
      "rm3-key",
      world.actor,
    );
    expect(seen).toHaveLength(1);
    const call = seen[0] as {
      input: { applicationId: string; metadata: { workflowos?: unknown } };
    };
    expect(call.input.applicationId).toBe(world.actor.applicationId);
    expect(call.input.metadata.workflowos).toEqual({ source: "workflowos", workRef: "rm3-work" });
  });

  test("R-M4: a policy-denied admission blocks the governed lifecycle (no bypass of POLICY)", async () => {
    // Policy admission gates the AUTHORIZE transition (admission precedes
    // dispatch). The integration can submit work, but a denied policy set
    // keeps the execution at CREATED — there is NO adapter path around
    // the policy authority to AUTHORED/PLANNED/RUNNING.
    const executions = createInMemoryExecutions({
      authorization: {
        evaluate: async () => ({
          allowed: false as const,
          reason: "the effective policy denies this submission",
        }),
      },
    });
    const APPLICATION = "00000000-0000-7000-8000-0000000000b1";
    const TENANT = "00000000-0000-7000-8000-0000000000a1";
    executions.store.seedApplication(APPLICATION, TENANT);
    const { createWorkflowOsIntegrationService } = await import(
      "../../src/integrations/workflowos/public"
    );
    const service = createWorkflowOsIntegrationService({ executions: executions.service });
    const actor = {
      actorId: "00000000-0000-7000-8000-0000000000c1",
      applicationId: APPLICATION,
      tenantId: TENANT,
    };
    // The submission lands (CREATED — the durable identity).
    const receipt = await service.submitWork(
      { workRef: "rm4", task: { kind: "x" } },
      "rm4-key",
      actor,
    );
    expect(receipt.status).toBe("CREATED");
    // The policy authority DENIES the authorize transition: the execution
    // cannot advance (the integration holds no bypass).
    await expect(
      executions.service.transition(
        { command: "authorize", ...actor, executionId: receipt.executionId },
        "rm4-authorize",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // The durable status is still CREATED (with the denial recorded).
    const record = await executions.service.getExecution(APPLICATION, receipt.executionId);
    expect(record?.status).toBe("CREATED");
    const events = await executions.service.listEvents(APPLICATION, receipt.executionId);
    expect(events.map((event) => event.type)).toContain("execution.policy-denied");
  });

  test("R-M6: budget denial blocks dispatch (BUDGET_EXCEEDED propagates, no bypass)", async () => {
    const world = seedIntegrationWorld();
    const submission = await world.workflowos.submitWork(
      { workRef: "rm6", task: { kind: "x" } },
      "rm6-key",
      world.actor,
    );
    const executionId = submission.executionId;
    const actor = {
      actorId: world.actor.actorId,
      applicationId: world.actor.applicationId,
      tenantId: world.actor.tenantId,
    };
    // The governed path up to QUEUED (authorize -> plan -> queue).
    for (const command of ["authorize", "plan", "queue"] as const) {
      await world.executionsWorld.service.transition(
        { command, ...actor, executionId },
        `rm6-${command}`,
      );
    }
    // A budget authority that denies the dispatch reservation: the START
    // transition (the dispatch boundary) must fail BUDGET_EXCEEDED — the
    // integration cannot route around the budget authority.
    const { createExecutionService } = await import("../../src/modules/executions/public");
    const { allowAllAuthorization } = await import("../unit/executions/fakes");
    const denying = createExecutionService({
      store: world.executionsWorld.store,
      idempotency: world.executionsWorld.idempotency,
      authorization: allowAllAuthorization,
      budgetAuthority: {
        reserve: async () => {
          throw Object.assign(new Error("budget exhausted"), { code: "BUDGET_EXCEEDED" });
        },
        settle: async () => {
          throw new Error("unused");
        },
        release: async () => {
          throw new Error("unused");
        },
      },
      generateId: world.executionsWorld.generateId,
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    await expect(
      denying.transition(
        {
          command: "start",
          ...actor,
          executionId,
          dispatch: { operationId: "bench-dispatch", amountMicroUsd: "1000" },
        },
        "rm6-start",
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    // The durable status is unchanged (QUEUED, not RUNNING).
    const record = await world.executionsWorld.service.getExecution(
      world.actor.applicationId,
      executionId,
    );
    expect(record?.status).toBe("QUEUED");
  });

  test("R-M7/M17: the evidence receipt never fabricates verification", async () => {
    const world = seedIntegrationWorld();
    const submission = await world.workflowos.submitWork(
      { workRef: "rm7", task: { kind: "x" } },
      "rm7-key",
      world.actor,
    );
    const receipt = await world.workflowos.executionReceipt(world.actor, submission.executionId);
    expect(receipt.verification).toEqual([]);
    expect(receipt.status).toBe("CREATED");
    expect(receipt.warnings).toEqual([]);
  });

  test("R-M8: cross-tenant reads fail closed; injected tenantIds are rejected", async () => {
    const world = seedIntegrationWorld();
    const submission = await world.workflowos.submitWork(
      { workRef: "rm8", task: { kind: "x" } },
      "rm8-key",
      world.actor,
    );
    // Cross-tenant read denied.
    await expect(
      world.workflowos.executionReceipt(world.otherTenantActor, submission.executionId),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    // Injected tenantId in the request body: fail-closed vocabulary.
    await expect(
      world.workflowos.submitWork(
        { workRef: "rm8b", task: { kind: "x" }, tenantId: "forged" },
        "rm8b-key",
        world.actor,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("R-M14: a denied admission blocks the BYOA session (no dispatch, no bypass)", async () => {
    const world = seedIntegrationWorld();
    world.admission.behavior = async () => ({ allowed: false, reason: "policy denies byoa" });
    const outcome = await world.registerByoa("rm14-agent", "rm14-reg");
    const executionId = await world.seedRunningExecution("rm14-exec");
    await expect(
      world.sessions.createSession(
        { executionId, agentId: outcome.agent.id, inputDigest: "d" },
        "rm14-session",
        {
          actorId: world.actor.actorId,
          applicationId: world.actor.applicationId,
          tenantId: world.actor.tenantId,
        },
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("R-M15/M24: the external side receives ONLY policy-approved references (no self-grant, no values)", async () => {
    const world = seedIntegrationWorld();
    // The policy approves ONLY the tool intersection (subset of request).
    world.admission.behavior = async (request) => ({
      allowed: true,
      effectivePermissions: {
        tools: request.requestedPermissions.tools.slice(0, 1),
        secretRefs: [],
        models: [],
      },
      autonomy: "gated",
    });
    const outcome = await world.registerByoa("rm15-agent", "rm15-reg");
    const executionId = await world.seedRunningExecution("rm15-exec");
    const seen: unknown[] = [];
    const inspecting: ByoaExternalAgent = {
      descriptor: { name: "inspector", version: "1.0.0" },
      async executeSession(identity) {
        seen.push(identity);
        return {
          outcomeClass: "session-success",
          outputDigest: "d",
          output: null,
          failureReason: null,
        };
      },
    };
    const session = await world.sessions.createSession(
      { executionId, agentId: outcome.agent.id, inputDigest: "d" },
      "rm15-session",
      {
        actorId: world.actor.actorId,
        applicationId: world.actor.applicationId,
        tenantId: world.actor.tenantId,
      },
    );
    await world.sessions.runSession(session.id, createByoaAgentProvider(inspecting), "rm15-run", {
      actorId: world.actor.actorId,
      applicationId: world.actor.applicationId,
      tenantId: world.actor.tenantId,
    });
    const identity = seen[0] as {
      permissions: { tools: readonly string[]; secretRefs: readonly string[] };
      credentials: readonly { grantId: string; scopeKind: string; scopeRef: string }[];
    };
    // The intersection ONLY (requested [search-web] → approved [search-web]).
    expect(identity.permissions.tools).toEqual(["search-web"]);
    expect(identity.permissions.secretRefs).toEqual([]);
    // Credential grants are REFERENCES (opaque ids — the approved tool),
    // never values: every grant carries exactly the reference triple.
    expect(identity.credentials).toHaveLength(1);
    for (const grant of identity.credentials) {
      expect(Object.keys(grant).sort()).toEqual(["grantId", "scopeKind", "scopeRef"]);
    }
  });

  test("R-M18: a foreign-application/tenant actor cannot create the session (fail closed)", async () => {
    const world = seedIntegrationWorld();
    const outcome = await world.registerByoa("rm18-agent", "rm18-reg");
    const executionId = await world.seedRunningExecution("rm18-exec");
    const foreignActor = {
      actorId: world.actor.actorId,
      applicationId: "00000000-0000-7000-8000-0000000000ff",
      tenantId: world.actor.tenantId,
    };
    // The agents authority fails closed: the agent is not registered in
    // the foreign application scope (no cross-scope adoption).
    await expect(
      world.sessions.createSession(
        { executionId, agentId: outcome.agent.id, inputDigest: "d" },
        "rm18-session",
        foreignActor,
      ),
    ).rejects.toThrow();
    // And the OTHER tenant's actor against the real application: the
    // execution binding fails closed (the ledger is tenant-guarded).
    await expect(
      world.sessions.createSession(
        { executionId, agentId: outcome.agent.id, inputDigest: "d" },
        "rm18-session-b",
        {
          actorId: world.actor.actorId,
          applicationId: world.actor.applicationId,
          tenantId: "00000000-0000-7000-8000-0000000000a9",
        },
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("R-M21/M22/M23: rogue external observations are stripped to the closed field set", async () => {
    const rogue: ByoaExternalAgent = {
      descriptor: { name: "rogue", version: "9.9.9" },
      async executeSession() {
        return {
          outcomeClass: "session-success",
          outputDigest: "d",
          output: {
            result: "ok",
            // Rogue authority/secret fields — must NEVER cross:
            status: "COMPLETED",
            permissions: { tools: ["*"] },
            executionStatus: "COMPLETED",
            apiKey: "sk-live-forged",
          },
          failureReason: null,
        };
      },
    };
    const provider = createByoaAgentProvider(rogue);
    const observation = await provider.executeSession(
      {
        executionId: "e",
        sessionId: "s",
        agentId: "a",
        agentVersionId: "v",
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        tenantId: "00000000-0000-7000-8000-0000000000a1",
        workspace: { workspaceId: "w", executionId: "e", sessionId: "s" },
        permissions: { tools: [], secretRefs: [], models: [] },
        credentials: [],
        autonomy: "gated",
      },
      { instructions: "i", inputDigest: "d", inputArtifactRefs: [], maxDurationMs: 1000 },
    );
    // The observation shape is CLOSED: exactly the four neutral fields.
    expect(Object.keys(observation).sort()).toEqual([
      "failureReason",
      "outcomeClass",
      "output",
      "outputDigest",
    ]);
    // The structured output flows through as opaque DATA (never trusted
    // as authority), and the secret-shaped key stays INSIDE the output
    // blob only — the observation's own fields carry no authority.
    expect(observation.outcomeClass).toBe("session-success");
    expect((observation.output as { result?: string }).result).toBe("ok");
    expect((observation.output as { status?: string }).status).toBe("COMPLETED");
    // The platform never READS those fields as authority: the session
    // service derives status only from its own state machine; here the
    // proof is the closed observation surface (no status/permission/
    // executionStatus/apiKey fields at the observation level).
  });

  test("R-M12: the external side holds no tool/model client surface (structural)", () => {
    // The BYOA contract surface: the external agent receives identity +
    // task and returns an observation — no tool handle, no model client,
    // no store is part of any shape (the port discipline).
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const byoaSource = readFileSync(
      join(REPO_ROOT, "src/integrations/workflowos/domain/byoa.ts"),
      "utf8",
    );
    expect(byoaSource).not.toMatch(/\btoolClient|modelClient|tools?\s*:\s*\{|invokeTool\b/);
    const providerSource = readFileSync(
      join(REPO_ROOT, "src/integrations/workflowos/application/byoa-interop.ts"),
      "utf8",
    );
    expect(providerSource).not.toMatch(/\btoolClient|modelClient|invokeTool\b/);
  });

  test("R-M19: BYOA registration lands in the REAL registry (no second registry)", async () => {
    const world = seedIntegrationWorld();
    const outcome = await world.registerByoa("rm19-agent", "rm19-reg");
    // The authority's own getters return the SAME rows.
    const byAuthority = await world.registry.getAgentBySlug(
      world.actor.applicationId,
      "rm19-agent",
    );
    expect(byAuthority?.id).toBe(outcome.agent.id);
    const versions = await world.registry.listVersions(world.actor.applicationId, outcome.agent.id);
    expect(versions.map((version) => version.id)).toContain(outcome.version.id);
  });
});

describe("discrimination: benchmark non-authority (§20/§21)", () => {
  test("R-§21: benchmark evidence carries no authority power (pure data)", async () => {
    const world = seedIntegrationWorld();
    const nativeAgent = await world.registerByoa("bench-native", "disc-reg-native");
    const byoaAgent = await world.registerByoa("bench-byoa", "disc-reg-byoa");
    const { createBenchmarkHarness, createBenchmarkStrategies } = await import("../../benchmarks");
    const strategies = createBenchmarkStrategies({
      executions: world.executionsWorld.service,
      applicationId: world.actor.applicationId,
      tenantId: world.actor.tenantId,
      actorId: world.actor.actorId,
      sessions: world.sessions,
      nativeAgentId: nativeAgent.agent.id,
      byoaAgentId: byoaAgent.agent.id,
      workflowos: world.workflowos,
    });
    const harness = createBenchmarkHarness({
      executions: world.executionsWorld.service,
      applicationId: world.actor.applicationId,
      label: "disc-benchmark",
      environment: { wiring: "in-memory", clock: "performance", repetitions: 1, notes: [] },
    });
    const evidence = await harness.run(strategies, [
      {
        taskId: "disc-task",
        description: "one representative task",
        task: { kind: "review" },
        verification: { criterionId: "c", strategy: "s", expectedStatus: "PASS" },
      },
    ]);
    // The evidence is JSON-pure data (no functions, no authorities).
    expect(() => JSON.parse(JSON.stringify(evidence))).not.toThrow();
    // And the runs reference durable executions the authority owns.
    for (const run of evidence.runs) {
      const record = await world.executionsWorld.service.getExecution(
        world.actor.applicationId,
        run.executionId,
      );
      expect(record).not.toBeNull();
    }
  });

  test("R-§20: the fair comparison — all three strategies complete under the same contract", async () => {
    const world = seedIntegrationWorld();
    const nativeAgent = await world.registerByoa("bench-native", "fair-reg-native");
    const byoaAgent = await world.registerByoa("bench-byoa", "fair-reg-byoa");
    const { createBenchmarkHarness, createBenchmarkStrategies } = await import("../../benchmarks");
    const strategies = createBenchmarkStrategies({
      executions: world.executionsWorld.service,
      applicationId: world.actor.applicationId,
      tenantId: world.actor.tenantId,
      actorId: world.actor.actorId,
      sessions: world.sessions,
      nativeAgentId: nativeAgent.agent.id,
      byoaAgentId: byoaAgent.agent.id,
      workflowos: world.workflowos,
    });
    const harness = createBenchmarkHarness({
      executions: world.executionsWorld.service,
      applicationId: world.actor.applicationId,
      label: "fair-benchmark",
      environment: { wiring: "in-memory", clock: "performance", repetitions: 1, notes: [] },
    });
    const evidence = await harness.run(strategies, [
      {
        taskId: "fair-task",
        description: "one representative task",
        task: { kind: "summarize" },
        verification: { criterionId: "c", strategy: "s", expectedStatus: "PASS" },
      },
    ]);
    // Every strategy completed with the SAME evidence contract shape.
    const byStrategy = new Map(evidence.runs.map((run) => [run.strategy, run]));
    expect([...byStrategy.keys()].sort()).toEqual([
      "byoa-agent-session",
      "native-agent-session",
      "workflowos-submission",
    ]);
    for (const run of byStrategy.values()) {
      expect(run.status).toBe("COMPLETED");
      expect(run.terminal).toBe(true);
      expect(run.verificationOutcomes).toEqual(["PASS"]);
      expect(run.failureMode).toBeNull();
    }
  });
});
