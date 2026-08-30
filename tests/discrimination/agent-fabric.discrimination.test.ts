/**
 * Discrimination: the agent fabric boundary (WORK-011 HIGH_ASSURANCE
 * boundaries; checkpoint contracts AUTH-PRESERVATION, DEPENDENCY-DIRECTION,
 * TENANT-ISOLATION, POLICY-BEFORE-DISPATCH, EXECUTION-PROVENANCE,
 * EXTERNAL-SIDE-EFFECTS, IDENTITY-IDEMPOTENCY, SELF-HOSTING-BOUNDARY).
 *
 * Every explicitly named M1..M24 boundary is proven by a mutant that
 * removes it — a weakened implementation FAILS the corresponding proof:
 *
 *   STATIC MUTANTS (the shared scanner over mutated REAL source — the
 *   WORK-006/007/010 red-record pattern; the architecture gate runs the
 *   same scanner over the real tree, so it fails under exactly these
 *   mutations):
 *     M1  agent re-exports execution status vocabulary (second abstraction)
 *     M2  AgentProvider imports/collapses into ModelProvider
 *     M3/M4 workspace scope check deleted (tenant + application)
 *     M5  execution tenant check deleted
 *     M6  definition validation deleted (raw secrets become publishable)
 *     M7  runtime credentials field becomes secret values
 *     M8  grant usability re-validation deleted
 *     M9  session bundle carries requested (not effective) permissions
 *     M10 policy admission call deleted / denial branch dropped
 *     M11 tool permission check deleted
 *     M12 approval gate / authorization check deleted
 *     M13 session-status dispatch guard deleted (side effect before approval)
 *     M14 approval tenant check deleted
 *     M15 version update/delete path appears in the store port
 *     M16 rollback stops appending selection records
 *     M17 registration convergence (ON CONFLICT) deleted
 *     M18 session convergence (ON CONFLICT) deleted
 *     M19 agents writes executions tables directly
 *     M20 evidence stops flowing through recordStepEvent
 *     M21 provenance payload stripped
 *     M22 provider SDK imported / vendor identifiers leak
 *     M23 a second policy/capability/budget authority appears
 *     M24 the provider port couples to execution transitions
 *
 *   RUNTIME RED RECORDS (observed violations under CONSTRUCTED wiring
 *     mutants — the wiring failure each static protection makes
 *     unrepresentable; production blocks the identical scenario):
 *     R1 allow-all admission wired while the REAL policy denies → the
 *        session is created (violation); production wiring: POLICY_DENIED.
 *     R2 a self-granting admission (requested = effective) wired → the
 *        runtime identity carries UNAPPROVED tools + unconstrained
 *        autonomy (violation); production: the intersection + the clamp.
 *     R3 a no-op ledger wired → the session succeeds with ZERO execution
 *        ledger envelopes (violation); production: required seam, one
 *        started envelope per session.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AgentAdmission } from "../../src/modules/agents/ports/agent-admission";
import type { AgentExecutionLedger } from "../../src/modules/agents/ports/agent-execution-ledger";
import type {
  AgentProvider,
  AgentSessionObservation,
} from "../../src/modules/agents/ports/agent-provider";
import type { AgentDefinition } from "../../src/modules/agents/public";
import {
  createAgentRegistry,
  createAgentSessionService,
  createPolicyAgentAdmission,
  InMemoryAgentStore,
} from "../../src/modules/agents/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../src/modules/policies/public";
import { PlatformError } from "../../src/shared/errors";
import {
  ACTOR_ID,
  APPLICATION_ID,
  allowAll,
  FakeAgentAdmission,
  FakeExecutionLedger,
  RecordingAgentProvider,
  TENANT_ID,
} from "../unit/agents/fakes";
import {
  type AgentFabricFile,
  agentFabricViolations,
  hasCanonicalAgentFabric,
} from "./lib/agent-fabric";

const REPO_ROOT = join(process.cwd());

function realTree(): AgentFabricFile[] {
  const files: AgentFabricFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relative);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: relative, content: readFileSync(join(REPO_ROOT, relative), "utf8") });
      }
    }
  };
  walk("src/modules/agents");
  return files;
}

function mutate(
  tree: AgentFabricFile[],
  path: string,
  replacement: (content: string) => string,
): AgentFabricFile[] {
  return tree.map((file) =>
    file.path === path ? { ...file, content: replacement(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// Static mutants (the shared scanner must flag each removal)
// ---------------------------------------------------------------------------

describe("discrimination: static agent-fabric mutants", () => {
  test("scanner honesty: the unmutated real tree yields ZERO violations", () => {
    const tree = realTree();
    expect(hasCanonicalAgentFabric(tree)).toBe(true);
    expect(agentFabricViolations(tree)).toEqual([]);
  });

  test("M1: re-exporting execution status vocabulary is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/agents/public.ts", (content) =>
      content.replace(
        "export const moduleDescriptor",
        "export type ExecutionStatus = string;\nexport const moduleDescriptor",
      ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-execution-status-vocabulary");
  });

  test("M2: AgentProvider collapsing into ModelProvider is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/agents/ports/agent-provider.ts", (content) =>
      content.replace(
        "import type { WorkspaceIdentity }",
        'import type { ModelProvider } from "../../models/public";\nimport type { WorkspaceIdentity }',
      ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-provider-models-collapse");
  });

  test("M3/M4: the workspace scope check deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace(
          "const scopeError = checkWorkspaceScope(",
          "const scopeError = null ?? checkDisabled(",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-workspace-scope-check-missing");
  });

  test("M5: the execution tenant check deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) => content.replace("if (execution.tenantId !== actor.tenantId) {", "if (false) {"),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-execution-tenant-check-missing");
  });

  test("M6: definition validation deleted (raw secrets publishable) is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/agent-registry.ts",
      (content) =>
        content.replace(
          "const check = validateAgentDefinition(",
          "const check = { valid: true } ?? validateDisabled(",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-definition-validation-missing");
  });

  test("M7: the runtime credentials field becoming secret values is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/agents/ports/agent-provider.ts", (content) =>
      content.replace(
        "readonly credentials: readonly CredentialGrantReference[];",
        "readonly credentials: readonly string[];",
      ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-runtime-secret-field");
  });

  test("M8: grant usability re-validation deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content
          .replace("grantIsUsable(candidate.status, candidate.expiresAt, iso())", "true")
          .replace("grantIsUsable(grant.status, grant.expiresAt, at)", "true"),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-grant-usability-check-missing");
  });

  test("M9: the session bundle carrying REQUESTED permissions is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace(
          "effectivePermissions: decision.effectivePermissions,",
          "effectivePermissions: version.definition.requestedPermissions as never,",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-permission-intersection-bypass");
  });

  test("M10: the policy admission call deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace(
          /const decision = await admission\.admit\(\{[\s\S]*?\n {6}\}\);/,
          "const decision = { allowed: true } as const;",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-policy-gate-missing");
  });

  test("M10b: the policy denial branch dropped is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace("if (!decision.allowed) {", "if (decision.allowed === false && false) {"),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-policy-gate-no-denial-branch");
  });

  test("M11: the tool permission check deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace(
          "if (!session.effectivePermissions.tools.includes(input.toolRef)) {",
          "if (false) {",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-tool-permission-check-missing");
  });

  test("M12: the approval gate deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) => content.replace(/const gated =\n[\s\S]*?;/, "const gated = false;"),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-approval-gate-missing");
  });

  test("M12b: the approval authorization check deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) => content.replace("approvalAuthorizesDispatch(candidate, iso())", "true"),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-approval-authorization-check-missing");
  });

  test("M13: the session-status dispatch guard deleted (side effect before approval) is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace(
          'if (session.status !== "running") {\n        // waiting-approval blocks ALL dispatch',
          "if (false) {\n        // waiting-approval blocks ALL dispatch",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-session-status-dispatch-guard-missing");
  });

  test("M14: the approval tenant check deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replaceAll("if (approval.tenantId !== actor.tenantId) {", "if (false) {"),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-approval-tenant-check-missing");
  });

  test("M15: a version update/delete path appearing in the store port is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/agents/ports/agent-store.ts", (content) =>
      content.replace(
        "// ---- sessions (governed session lifecycle) ----",
        "updateVersion(applicationId: string, versionId: string): Promise<AgentVersionRecord>;\n  // ---- sessions (governed session lifecycle) ----",
      ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-version-update-path");
  });

  test("M16: rollback no longer appending selection records is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/agent-registry.ts",
      (content) =>
        content.replace(
          'return appendSelection(input, "rollback", current?.id ?? null, idempotencyKey, actor);',
          'return appendSelection(input, "promotion", null, idempotencyKey, agent);',
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-rollback-selection-missing");
  });

  test("M17: registration convergence deleted is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/agents/adapters/sql-agent-store.ts", (content) =>
      content.replace("ON CONFLICT (application_id, slug) DO NOTHING", "ON CONFLICT DO NOTHING"),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-registration-no-convergence");
  });

  test("M18: session convergence deleted is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/agents/adapters/sql-agent-store.ts", (content) =>
      content.replace(
        "ON CONFLICT (application_id, session_key) DO NOTHING",
        "ON CONFLICT DO NOTHING",
      ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-session-no-convergence");
  });

  test("M19: agents writing executions tables directly is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace(
          "const execution = await ledger.getExecution(",
          "await store.execute({ sql: 'INSERT INTO executions.executions' });\n    const execution = await ledger.getExecution(",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-writes-authority-tables");
  });

  test("M20: evidence bypassing the canonical ledger is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace(
          /const outcome = await ledger\.recordStepEvent\(\n[\s\S]*?\n {6}idempotencyKey,\n {4}\);/,
          "const outcome = { sequence: 0, replayed: false };",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-evidence-ledger-bypass");
  });

  test("M21: the provenance payload stripped is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/application/session-service.ts",
      (content) =>
        content.replace(
          "          autonomy: session.autonomy,\n          policyEvidence: { ...session.policyEvidence },",
          "          autonomy: session.autonomy,",
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-evidence-provenance-stripped");
  });

  test("M22: a provider SDK imported into agents is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/agents/adapters/execution-ledger.ts",
      (content) =>
        content.replace(
          "import type { ExecutionService }",
          'import { OpenAI } from "openai";\nimport type { ExecutionService }',
        ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-provider-sdk-import");
  });

  test("M23: a second policy authority defined in agents is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/agents/domain/permissions.ts", (content) =>
      content.replace(
        "export interface EffectivePermissions {",
        "export interface PolicyAuthority {\n  decideEverything(): boolean;\n}\n\nexport interface EffectivePermissions {",
      ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-second-authority");
  });

  test("M24: the provider port coupling to execution transitions is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/agents/ports/agent-provider.ts", (content) =>
      content.replace(
        "  readonly autonomy: AutonomyMode;",
        "  readonly autonomy: AutonomyMode;\n  /** mutant: the provider drives execution transitions. */\n  waitHuman(): Promise<void>;",
      ),
    );
    expect(agentFabricViolations(mutant)).toContain("agent-provider-execution-coupled");
  });
});

// ---------------------------------------------------------------------------
// Runtime red records (constructed wiring mutants)
// ---------------------------------------------------------------------------

const DEFINITION: AgentDefinition = {
  instructions: "Triage the inbox.",
  requestedPermissions: { tools: ["search-web"], secretRefs: [] },
  approvalRequiredActions: ["external-send"],
  isolation: "container",
  maxAutonomy: "unconstrained",
  maxSessionDurationMs: 600000,
};

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
const actor = () => ({ actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID });

const generateId = (() => {
  let counter = 0;
  return () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
})();
const now = () => new Date();
const hash = (v: string) => `d:${v.length}`;

async function buildWorld(admission: AgentAdmission, ledger: AgentExecutionLedger) {
  const store = new InMemoryAgentStore();
  const registry = createAgentRegistry({ store, generateId, now, hashDefinition: hash });
  const service = createAgentSessionService({
    store,
    admission,
    ledger,
    generateId,
    now,
    hashValue: hash,
  });
  const agent = await registry.registerAgent(
    { applicationId: APPLICATION_ID, tenantId: TENANT_ID, slug: "triage", name: "Triage" },
    "r",
    actor(),
  );
  const version = await registry.publishVersion(
    { agentId: agent.id, version: "1.0.0", definition: DEFINITION },
    "p",
    actor(),
  );
  await registry.promote({ agentId: agent.id, targetVersionId: version.id }, "m", actor());
  return { store, service, agentId: agent.id };
}

describe("discrimination: runtime red records (wiring mutants)", () => {
  test("R1: an allow-all admission wired while the REAL policy denies (M10 runtime)", async () => {
    // The REAL policy authority with a set that denies everything except
    // the baseline (tools NOT on the allowlist → the tool fact is denied,
    // which production turns into the intersection; here we deny the
    // EXECUTION-level admission).
    const authority = createPolicyAuthority({
      store: new InMemoryPolicyStore(),
      hasher: nodePolicyHasher,
    });
    await authority.publish({
      id: "deny-agents",
      version: 1,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: {
            autonomy: { maxAutonomy: "none" },
            tool: { deniedTools: ["search-web"] },
          },
        },
      ],
    });

    // WIRING MUTANT: an allow-all admission (this is what a default-allow
    // seam would do — the static protection makes shipping one
    // unrepresentable in src/; a composition root COULD still wire a
    // hand-rolled fake, so the production adapter is the guard).
    const rogueAdmission: AgentAdmission = {
      admit: async () => ({
        allowed: true,
        effectivePermissions: { tools: ["search-web"], secretRefs: [], models: [] },
        autonomy: "unconstrained",
        evidence: {
          policySetId: "rogue",
          policySetVersion: 1,
          policyContentHash: "rogue",
          restrictionSetDigest: "rogue",
        },
      }),
    };
    const ledger = new FakeExecutionLedger();
    ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const rogueWorld = await buildWorld(rogueAdmission, ledger);
    // VIOLATION observed: the rogue session is created against a policy
    // whose effective autonomy ceiling is "none"...
    const rogueSession = await rogueWorld.service.createSession(
      { executionId: EXECUTION_ID, agentId: rogueWorld.agentId, inputDigest: "d" },
      "rogue",
      actor(),
    );
    expect(rogueSession.autonomy).toBe("unconstrained"); // the violation

    // PRODUCTION: the real adapter delegates — autonomy is CLAMPED to the
    // policy ceiling and the intersection is honored.
    const productionLedger = new FakeExecutionLedger();
    productionLedger.seedExecution(EXECUTION_ID, "RUNNING");
    const productionWorld = await buildWorld(
      createPolicyAgentAdmission(authority),
      productionLedger,
    );
    const session = await productionWorld.service.createSession(
      { executionId: EXECUTION_ID, agentId: productionWorld.agentId, inputDigest: "d" },
      "production",
      actor(),
    );
    expect(session.autonomy).toBe("none"); // clamped by the policy ceiling
    expect(session.effectivePermissions.tools).toEqual([]); // tool not allowlisted → excluded
  });

  test("R2: a self-granting admission wired (requested = effective, M9 runtime)", async () => {
    const authority = createPolicyAuthority({
      store: new InMemoryPolicyStore(),
      hasher: nodePolicyHasher,
    });
    await authority.publish({
      id: "restrictive",
      version: 1,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: { tool: { deniedTools: ["search-web"] } },
        },
      ],
    });

    // WIRING MUTANT: grants everything requested (self-grant).
    const selfGranting: AgentAdmission = {
      admit: async (request) => ({
        allowed: true,
        effectivePermissions: {
          tools: [...request.requestedPermissions.tools],
          secretRefs: [...request.requestedPermissions.secretRefs],
          models: [...(request.requestedPermissions.models ?? [])],
        },
        autonomy: request.requestedAutonomy,
        evidence: {
          policySetId: "rogue",
          policySetVersion: 1,
          policyContentHash: "rogue",
          restrictionSetDigest: "rogue",
        },
      }),
    };
    const rogueLedger = new FakeExecutionLedger();
    rogueLedger.seedExecution(EXECUTION_ID, "RUNNING");
    const rogueWorld = await buildWorld(selfGranting, rogueLedger);
    const rogueSession = await rogueWorld.service.createSession(
      { executionId: EXECUTION_ID, agentId: rogueWorld.agentId, inputDigest: "d" },
      "rogue",
      actor(),
    );
    await rogueWorld.store.transitionSession(APPLICATION_ID, rogueSession.id, "running", {
      startedAt: new Date().toISOString(),
    });
    const rogueProvider = new RecordingAgentProvider("local");
    await rogueWorld.service.runSession(rogueSession.id, rogueProvider, "rk", actor());
    // VIOLATION observed: the runtime identity carries the UNAPPROVED tool.
    expect(rogueProvider.identities[0]?.permissions.tools).toContain("search-web");

    // PRODUCTION: the real adapter intersects — the tool is NOT in the
    // effective set (no tool allowlist published → not on the list).
    const productionLedger = new FakeExecutionLedger();
    productionLedger.seedExecution(EXECUTION_ID, "RUNNING");
    const productionWorld = await buildWorld(
      createPolicyAgentAdmission(authority),
      productionLedger,
    );
    const session = await productionWorld.service.createSession(
      { executionId: EXECUTION_ID, agentId: productionWorld.agentId, inputDigest: "d" },
      "production",
      actor(),
    );
    await productionWorld.store.transitionSession(APPLICATION_ID, session.id, "running", {
      startedAt: new Date().toISOString(),
    });
    const provider = new RecordingAgentProvider("local");
    await productionWorld.service.runSession(session.id, provider, "rk", actor());
    expect(provider.identities[0]?.permissions.tools).toEqual([]);
  });

  test("R3: a no-op ledger wired (M20 runtime)", async () => {
    const admission = new FakeAgentAdmission();
    admission.behavior = async (request) => allowAll(request);

    // WIRING MUTANT: a ledger that records nothing (what a no-op
    // implementation would do — the REQUIRED port has no no-op in src/).
    const noopLedger: AgentExecutionLedger = {
      recordStepEvent: async () => ({ sequence: 0, type: "void", replayed: false }),
      getExecution: async () => {
        const record = new FakeExecutionLedger();
        record.seedExecution(EXECUTION_ID, "RUNNING");
        return record.getExecution(APPLICATION_ID, EXECUTION_ID);
      },
      waitHuman: async () => ({ sequence: 0, replayed: false }),
      resume: async () => ({ sequence: 0, replayed: false }),
    };
    const rogueWorld = await buildWorld(admission, noopLedger);
    const rogueSession = await rogueWorld.service.createSession(
      { executionId: EXECUTION_ID, agentId: rogueWorld.agentId, inputDigest: "d" },
      "rogue",
      actor(),
    );
    await rogueWorld.store.transitionSession(APPLICATION_ID, rogueSession.id, "running", {
      startedAt: new Date().toISOString(),
    });
    const observation: AgentSessionObservation = {
      outcomeClass: "session-success",
      outputDigest: "d",
      output: {},
      failureReason: null,
    };
    const provider: AgentProvider = {
      runtimeKind: "local",
      executeSession: async () => observation,
    };
    await rogueWorld.service.runSession(rogueSession.id, provider, "rk", actor());
    // VIOLATION observed: the session's evidence sequence is the no-op's
    // fabricated 0 — NO envelope exists anywhere (zero real evidence).
    expect(rogueSession.ledgerStartSequence).toBe(0);

    // PRODUCTION: the faithful ledger records the envelopes.
    const faithfulLedger = new FakeExecutionLedger();
    faithfulLedger.seedExecution(EXECUTION_ID, "RUNNING");
    const productionWorld = await buildWorld(admission, faithfulLedger);
    const session = await productionWorld.service.createSession(
      { executionId: EXECUTION_ID, agentId: productionWorld.agentId, inputDigest: "d" },
      "production",
      actor(),
    );
    expect(faithfulLedger.events.map((e) => e.event.command)).toContain("agent-session-started");
    const reloaded = await productionWorld.service.getSession(APPLICATION_ID, session.id);
    expect(reloaded?.ledgerStartSequence).not.toBeNull();
  });

  test("the production approval gate holds even when the session state is forced (M12/M13 runtime)", async () => {
    const admission = new FakeAgentAdmission();
    admission.behavior = async () => ({
      allowed: true,
      effectivePermissions: { tools: [], secretRefs: [], models: [] },
      autonomy: "gated",
      evidence: {
        policySetId: "default",
        policySetVersion: 1,
        policyContentHash: "h",
        restrictionSetDigest: "d",
      },
    });
    const ledger = new FakeExecutionLedger();
    ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const world = await buildWorld(admission, ledger);
    const session = await world.service.createSession(
      { executionId: EXECUTION_ID, agentId: world.agentId, inputDigest: "d" },
      "gate",
      actor(),
    );
    await world.store.transitionSession(APPLICATION_ID, session.id, "running", {
      startedAt: new Date().toISOString(),
    });
    const approval = await world.service.requestApproval(
      { sessionId: session.id, actionClass: "external-send", descriptor: {}, policyBasis: "gated" },
      "approval",
      actor(),
    );
    expect(approval.status).toBe("pending");

    // ATTACK: force the session back to running through the store
    // (bypassing the service transition) and dispatch the gated action.
    await world.store.transitionSession(APPLICATION_ID, session.id, "running", {});
    // The dispatch boundary STILL demands the approved record: the side
    // effect is impossible while the approval is pending.
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "external-send", descriptor: {} },
        "forced-dispatch",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    // And a REVOKED approval (post-approval revocation) blocks it too.
    await world.service.decideApproval(
      { approvalId: approval.id, decision: "approved", approverId: "human" },
      "decide",
      actor(),
    );
    await world.service.revokeApproval(approval.id, actor());
    await expect(
      world.service.recordAction(
        { sessionId: session.id, actionClass: "external-send", descriptor: {} },
        "revoked-dispatch",
        actor(),
      ),
    ).rejects.toBeInstanceOf(PlatformError);
  });
});
