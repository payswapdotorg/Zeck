/**
 * Discrimination: the sandbox boundary (WORK-012 CRITICAL boundaries;
 * checkpoint contracts DEPENDENCY-DIRECTION, TENANT-ISOLATION,
 * POLICY-BEFORE-DISPATCH, BUDGET-INTEGRITY, SANDBOX-BOUNDARY,
 * EXECUTION-PROVENANCE, IDENTITY-IDEMPOTENCY, SELF-HOSTING-BOUNDARY).
 *
 * Every explicitly named M1..M18 boundary is proven by a mutant that
 * removes it — a weakened implementation FAILS the corresponding proof:
 *
 *   STATIC MUTANTS (the shared scanner over mutated REAL source — the
 *   WORK-006/007/010/011 red-record pattern; the architecture gate runs
 *   the same scanner over the real tree, so it fails under exactly these
 *   mutations):
 *     M1  ambient host environment inheritance appears
 *     M2  policy admission call deleted / denial branch dropped /
 *         adapter stops delegating to the real authority
 *     M3  capability admission call deleted / adapter stops delegating
 *     M4  budget reservation deleted / fail-closed check dropped /
 *         resource limits stop being required
 *     M5  host-mount detection deleted (validator + domain)
 *     M6  host-network rejection deleted from the escape validator
 *     M7  device/privilege rejection deleted from the escape validator
 *     M8  secret validation deleted / runtime spec carries secret values
 *     M9  execution tenant check deleted
 *     M10 catalog scope check deleted
 *     M11 sandbox convergence (ON CONFLICT) deleted / reuse rejection dropped
 *     M12 request fingerprint deleted
 *     M13 a runtime-metadata update path appears / dispatch stops being
 *         snapshot-driven
 *     M14 provider vocabulary leaks into the public barrel / the provider
 *         port couples to execution transitions / an SDK is imported
 *     M15 the dispatch claim / denied-dispatch guard is deleted
 *     M16 sandbox writes executions tables directly / evidence bypasses
 *         recordStepEvent
 *     M17 no-execution stops being first class
 *     M18 the fail-closed posture is deleted (container without a client
 *         would execute anyway; crash-unknown stops failing closed)
 *
 *   RUNTIME RED RECORDS (observed violations under CONSTRUCTED wiring
 *     mutants — the wiring failure each static protection makes
 *     unrepresentable; production blocks the identical scenario):
 *     R1 an allow-all admission wired while the REAL policy denies → the
 *        sandbox is admitted (violation); production wiring: POLICY_DENIED.
 *     R2 the isolation floor: the REAL policy (minIsolation=container)
 *        denies a process sandbox for untrusted work; production wiring
 *        rejects with the authority's denial.
 *     R3 a no-op ledger wired → the sandbox completes with ZERO execution
 *        ledger envelopes (violation); production: required seam, one
 *        admitted + one completed envelope per sandbox.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../src/modules/policies/public";
import { createSandboxProviderRegistry } from "../../src/modules/sandbox/ports/sandbox-provider";
import {
  createEnvironmentCatalog,
  createPolicySandboxAdmission,
  createSandboxService,
  InMemorySandboxStore,
} from "../../src/modules/sandbox/public";
import { PlatformError } from "../../src/shared/errors";
import {
  ACTOR_ID,
  APPLICATION_ID,
  FakeCapabilityGate,
  FakeExecutionLedger,
  FakeSandboxAdmission,
  RecordingSandboxProvider,
  SUCCESS_OBSERVATION,
  TENANT_ID,
} from "../unit/sandbox/fakes";
import {
  hasCanonicalSandboxFabric,
  type SandboxFabricFile,
  sandboxFabricViolations,
} from "./lib/sandbox";

const REPO_ROOT = join(process.cwd());

function realTree(): SandboxFabricFile[] {
  const files: SandboxFabricFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(relative);
      } else if (entry.name.endsWith(".ts")) {
        files.push({ path: relative, content: readFileSync(join(REPO_ROOT, relative), "utf-8") });
      }
    }
  };
  walk("src/modules/sandbox");
  walk("src/platform/sandbox");
  return files;
}

function mutate(
  tree: SandboxFabricFile[],
  path: string,
  replacement: (content: string) => string,
): SandboxFabricFile[] {
  return tree.map((file) =>
    file.path === path ? { ...file, content: replacement(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// Static mutants (the shared scanner must flag each removal)
// ---------------------------------------------------------------------------

describe("discrimination: static sandbox mutants", () => {
  test("scanner honesty: the unmutated real tree yields ZERO violations", () => {
    const tree = realTree();
    expect(hasCanonicalSandboxFabric(tree)).toBe(true);
    expect(sandboxFabricViolations(tree)).toEqual([]);
  });

  test("M1: ambient host environment inheritance appearing is rejected", () => {
    const mutant = mutate(realTree(), "src/platform/sandbox/process-runtime.ts", (content) =>
      content.replace(
        "const childEnv: Record<string, string> = { ...options.env };",
        "const childEnv: Record<string, string> = { ...process.env, ...options.env };",
      ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-ambient-environment");
  });

  test("M1b: the domain host-path check deleted is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/domain/environment.ts", (content) =>
      content.replace("if (refLooksLikeHostPath(ref)) {", "if (false) {"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-host-path-check-missing");
  });

  test("M2: the policy admission call deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace(
          /const decision = await admission\.admit\(\{[\s\S]*?\n {6}\}\);/,
          "const decision = { allowed: true } as const;",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-policy-gate-missing");
  });

  test("M2b: the policy denial branch dropped is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace("if (!decision.allowed) {", "if (decision.allowed === false && false) {"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-policy-gate-no-denial-branch");
  });

  test("M2c: the admission adapter stopping delegation is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/policy-sandbox-admission.ts",
      (content) =>
        content.replace(/from ["']\.\.\/\.\.\/policies\/public["']/, 'from "../../shared/errors"'),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-admission-not-delegating");
  });

  test("M3: the capability admission call deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace(
          /const resolution = await capabilities\.resolve\(\{[\s\S]*?\n {6}\}\);/,
          "const resolution = { satisfied: true, satisfactions: [] } as const;",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-capability-gate-missing");
  });

  test("M3b: the capability adapter stopping delegation is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/capability-gate.ts",
      (content) =>
        content.replace(
          /registry\.resolve\(profile\)/,
          "Promise.resolve({ satisfied: true, satisfactions: [] })",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-capability-not-delegating");
  });

  test("M4: the budget reservation deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace(
          /await budgetAuthority\.reserve\(/,
          "void (await Promise.resolve()).constructor; await budgetAuthority.reserveDisabled(",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-budget-reservation-missing");
  });

  test("M4b: resource limits no longer required is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/domain/environment.ts", (content) =>
      content.replaceAll(", true],", ", false],"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-resource-limits-not-required");
  });

  test("M5: host-mount detection deleted from the escape validator is rejected", () => {
    const mutant = mutate(realTree(), "src/platform/sandbox/container-profile.ts", (content) =>
      content.replace('if (mountSourceIsHostPath(mount.source ?? "")) {', "if (false) {"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-host-mount-detection-missing");
  });

  test("M6: host-network rejection deleted from the escape validator is rejected", () => {
    const mutant = mutate(realTree(), "src/platform/sandbox/container-profile.ts", (content) =>
      content.replace("if (config.hostNetwork === true) {", "if (false) {"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-escape-validator-missing");
  });

  test("M7: device/privilege rejection deleted from the escape validator is rejected", () => {
    const mutant = mutate(realTree(), "src/platform/sandbox/container-profile.ts", (content) =>
      content
        .replace("if (config.privileged === true) {", "if (false) {")
        .replace(
          "if (Array.isArray(config.devices) && config.devices.length > 0) {",
          "if (false) {",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-escape-validator-missing");
  });

  test("M8: secret validation deleted from the domain is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/domain/sandbox.ts", (content) =>
      content.replace("if (containsRawSecretValue(value)) {", "if (false) {"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-secret-validation-missing");
  });

  test("M8b: the runtime spec carrying secret VALUES is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/ports/sandbox-provider.ts", (content) =>
      content.replace(
        "readonly secretRefs: readonly string[];",
        "readonly secretValues: readonly string[];",
      ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-runtime-secret-field");
  });

  test("M9: the execution tenant check deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) => content.replace("if (execution.tenantId !== actor.tenantId) {", "if (false) {"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-execution-tenant-check-missing");
  });

  test("M10: the catalog scope check deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/environment-catalog.ts",
      (content) =>
        content.replace(
          "if (input.applicationId !== actor.applicationId || input.tenantId !== actor.tenantId) {",
          "if (false) {",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-catalog-scope-check-missing");
  });

  test("M11: sandbox convergence (ON CONFLICT) deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/sql-sandbox-store.ts",
      (content) =>
        content.replace(
          "ON CONFLICT (application_id, sandbox_key) DO NOTHING",
          "ON CONFLICT DO NOTHING",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-no-convergence");
  });

  test("M11b: the idempotency reuse rejection dropped is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) => content.replaceAll('"IDEMPOTENCY_KEY_REUSED"', '"SANDBOX_ERROR"'),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-idempotency-reuse-missing");
  });

  test("M12: the request fingerprint deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace(
          /const fingerprint = sandboxRequestFingerprint\([\s\S]*?\);/,
          'const fingerprint = "constant";',
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-fingerprint-missing");
  });

  test("M13: a runtime-metadata update path appearing is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/ports/sandbox-store.ts", (content) =>
      content.replace(
        "// ---- sandbox executions ----",
        "updateRuntimeMetadata(applicationId: string, sandboxKey: string, metadata: Readonly<Record<string, unknown>>): Promise<SandboxExecutionRecord>;\n  // ---- sandbox executions ----",
      ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-metadata-update-path");
  });

  test("M13b: dispatch no longer snapshot-driven is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace(
          "const metadata = record.runtimeMetadata;",
          "const metadata = ((await store.findEnvironment(record.applicationId, record.environmentId))?.spec ?? record.runtimeMetadata) as typeof record.runtimeMetadata;",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-dispatch-not-snapshot-driven");
  });

  test("M14: provider vocabulary leaking into the public barrel is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/public.ts", (content) =>
      content.replace(
        "export const moduleDescriptor",
        "export type DockerConfig = { image: string };\nexport const moduleDescriptor",
      ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-provider-vocabulary-leak");
  });

  test("M14b: the provider port coupling to execution transitions is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/ports/sandbox-provider.ts", (content) =>
      content.replace(
        "readonly runtimeKind: SandboxEnvironmentKind;",
        "readonly runtimeKind: SandboxEnvironmentKind;\n  /** mutant: the provider drives execution transitions. */\n  waitHuman(): Promise<void>;",
      ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-provider-execution-coupled");
  });

  test("M14c: an execution status vocabulary re-export is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/public.ts", (content) =>
      content.replace(
        "export const moduleDescriptor",
        "export type ExecutionStatus = string;\nexport const moduleDescriptor",
      ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-execution-status-vocabulary");
  });

  test("M15: the dispatch claim deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace(
          "const claim = await store.claimDispatching(",
          "const claim = { claimed: true, record: found } as const; void store.claimDispatchingDisabled(",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-dispatch-claim-missing");
  });

  test("M15b: the denied-dispatch guard deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace('message: "a denied sandbox cannot be dispatched",', 'message: "",'),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-denied-dispatch-guard-missing");
  });

  test("M16: sandbox writing executions tables directly is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace(
          "const execution = await ledger.getExecution(",
          "await store.execute?.({ sql: 'INSERT INTO executions.executions' });\n    const execution = await ledger.getExecution(",
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-writes-authority-tables");
  });

  test("M16b: evidence bypassing the canonical ledger is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) =>
        content.replace(
          /const outcome = await ledger\.recordStepEvent\(\n[\s\S]*?\n {6}`\$\{record\.id\}:\$\{command\}`,\n {4}\);/,
          'const outcome = { sequence: 0, type: "noop", replayed: false };',
        ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-evidence-ledger-bypass");
  });

  test("M17: no-execution no longer first class is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) => content.replace("if (!kindExecutes(metadata.kind)) {", "if (false) {"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-no-execution-not-first-class");
  });

  test("M18: the container fail-closed posture deleted is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/container-provider.ts",
      (content) => content.replace("if (this.client === null) {", "if (false) {"),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-fail-closed-missing");
  });

  test("M18b: crash-unknown stopping failing closed is rejected", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/sandbox-service.ts",
      (content) => content.replaceAll('"NON_CONVERGENT_EXTERNAL_EFFECT"', '"SANDBOX_ERROR"'),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-crash-nonconvergent-missing");
  });

  test("M23-class: a second policy authority defined in sandbox is rejected", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/domain/sandbox.ts", (content) =>
      content.replace(
        "export interface SandboxTask {",
        "export interface PolicyAuthority {\n  decideEverything(): boolean;\n}\n\nexport interface SandboxTask {",
      ),
    );
    expect(sandboxFabricViolations(mutant)).toContain("sandbox-second-authority");
  });
});

// ---------------------------------------------------------------------------
// Runtime red records (constructed wiring mutants)
// ---------------------------------------------------------------------------

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
const actor = () => ({ actorId: ACTOR_ID, applicationId: APPLICATION_ID, tenantId: TENANT_ID });
const task = { command: "python3", args: ["analyze.py"], publicEnv: { MODE: "batch" } };

const processSpec = {
  kind: "process" as const,
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
  network: { egress: "none" as const, allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable" as const, readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] as string[] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

function buildWorld(
  admission: FakeSandboxAdmission | ReturnType<typeof createPolicySandboxAdmission>,
  ledger: FakeExecutionLedger,
) {
  const store = new InMemorySandboxStore();
  let counter = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
  const catalog = createEnvironmentCatalog({
    store,
    generateId,
    now: () => new Date(),
    hashSpec: (canonical) => `digest:${canonical.length}`,
  });
  const providers = createSandboxProviderRegistry();
  providers.register(new RecordingSandboxProvider("process", SUCCESS_OBSERVATION));
  const capabilities = new FakeCapabilityGate();
  const service = createSandboxService({
    store,
    admission: admission as never,
    capabilities: { resolve: capabilities.resolve },
    ledger,
    providers,
    generateId,
    now: () => new Date(),
  });
  return { store, catalog, service, providers };
}

describe("discrimination: runtime red records (wiring mutants)", () => {
  test("R1: an allow-all admission wired while the REAL policy has no configured set (M2 runtime)", async () => {
    // The REAL policy authority with NOTHING configured: deny-by-default.
    const authority = createPolicyAuthority({
      store: new InMemoryPolicyStore(),
      hasher: nodePolicyHasher,
    });

    // WIRING MUTANT: an allow-all admission (a default-allow seam — the
    // static protection makes shipping one unrepresentable in src/; a
    // composition root COULD still hand-roll one, so the production
    // adapter is the guard).
    const rogueAdmission = new FakeSandboxAdmission();
    rogueAdmission.decide({
      allowed: true,
      evidence: {
        policySetId: "rogue",
        policySetVersion: 1,
        policyContentHash: "rogue",
        restrictionSetDigest: "rogue",
      },
    });
    const ledger = new FakeExecutionLedger();
    ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const rogueWorld = buildWorld(rogueAdmission, ledger);
    const environmentId = (
      await rogueWorld.catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "analysis",
          name: "A",
          spec: processSpec,
        },
        "env",
        actor(),
      )
    ).id;
    // VIOLATION observed: the rogue sandbox is admitted with a fabricated
    // "policy" evidence while the real authority denies everything.
    const rogue = await rogueWorld.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "rogue-key",
      actor(),
    );
    expect(rogue.status).toBe("admitted"); // the violation
    expect(rogue.runtimeMetadata.policyEvidence?.policySetId).toBe("rogue");

    // PRODUCTION: the real adapter delegates — the deny-by-default
    // authority refuses (no configured set).
    const productionLedger = new FakeExecutionLedger();
    productionLedger.seedExecution(EXECUTION_ID, "RUNNING");
    const productionWorld = buildWorld(createPolicySandboxAdmission(authority), productionLedger);
    const prodEnvironmentId = (
      await productionWorld.catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "analysis",
          name: "A",
          spec: processSpec,
        },
        "env",
        actor(),
      )
    ).id;
    await expect(
      productionWorld.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId: prodEnvironmentId, task },
        "production-key",
        actor(),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("R2: the isolation floor — the REAL policy (minIsolation=container) denies a process sandbox for untrusted work", async () => {
    const authority = createPolicyAuthority({
      store: new InMemoryPolicyStore(),
      hasher: nodePolicyHasher,
    });
    await authority.publish({
      id: "untrusted-container-floor",
      version: 1,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: { isolation: { minIsolation: "container" } },
        },
      ],
    });

    const ledger = new FakeExecutionLedger();
    ledger.seedExecution(EXECUTION_ID, "RUNNING");
    const world = buildWorld(createPolicySandboxAdmission(authority), ledger);
    const processEnvironmentId = (
      await world.catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "process-env",
          name: "P",
          spec: processSpec,
        },
        "env-p",
        actor(),
      )
    ).id;
    // PRODUCTION: the process environment is below the effective
    // isolation floor — POLICY_DENIED (untrusted code needs containers).
    await expect(
      world.service.createSandboxExecution(
        { executionId: EXECUTION_ID, environmentId: processEnvironmentId, task },
        "key-process",
        actor(),
      ),
    ).rejects.toBeInstanceOf(PlatformError);

    // And the container environment is ADMITTED at the same floor:
    const containerSpec = {
      ...processSpec,
      kind: "container" as const,
      runtime: { capabilityId: "container-runtime" },
    };
    const containerEnvironmentId = (
      await world.catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "container-env",
          name: "C",
          spec: containerSpec,
        },
        "env-c",
        actor(),
      )
    ).id;
    const admitted = await world.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId: containerEnvironmentId, task },
      "key-container",
      actor(),
    );
    expect(admitted.status).toBe("admitted");

    // And the no-execution environment remains admissible at the same
    // floor: nothing runs — there is no isolation to evaluate (M17).
    const noExecEnvironmentId = (
      await world.catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "noexec-env",
          name: "N",
          spec: {
            kind: "no-execution" as const,
            limits: null,
            network: { egress: "none" as const, allowedHosts: [] },
            filesystem: { workspace: "none" as const, readOnlyArtifactRefs: [] },
            secrets: { secretRefs: [] },
            runtime: null,
            cost: { estimatedCostMicroUsd: "0" },
          },
        },
        "env-n",
        actor(),
      )
    ).id;
    const noExec = await world.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId: noExecEnvironmentId, task },
      "key-noexec",
      actor(),
    );
    expect(noExec.status).toBe("admitted");
  });

  test("R3: a no-op ledger wired → zero execution envelopes (M16 runtime)", async () => {
    const admission = new FakeSandboxAdmission();
    const noopLedger = new FakeExecutionLedger();
    noopLedger.seedExecution(EXECUTION_ID, "RUNNING");
    // WIRING MUTANT: a no-op ledger that records nothing.
    const brokenLedger = {
      recordStepEvent: async () => ({ sequence: 0, type: "noop", replayed: false }),
      getExecution: async (applicationId: string, executionId: string) =>
        noopLedger.getExecution(applicationId, executionId),
    };
    const store = new InMemorySandboxStore();
    let counter = 0;
    const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
    const catalog = createEnvironmentCatalog({
      store,
      generateId,
      now: () => new Date(),
      hashSpec: (canonical) => `digest:${canonical.length}`,
    });
    const providers = createSandboxProviderRegistry();
    providers.register(new RecordingSandboxProvider("process", SUCCESS_OBSERVATION));
    const capabilities = new FakeCapabilityGate();
    const service = createSandboxService({
      store,
      admission,
      capabilities: { resolve: capabilities.resolve },
      ledger: brokenLedger as never,
      providers,
      generateId,
      now: () => new Date(),
    });
    const environmentId = (
      await catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "analysis",
          name: "A",
          spec: processSpec,
        },
        "env",
        actor(),
      )
    ).id;
    await service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId, task },
      "key-1",
      actor(),
    );
    await service.dispatchSandboxExecution(
      {
        applicationId: APPLICATION_ID,
        sandboxId: (await store.findSandboxByKey(APPLICATION_ID, "key-1"))?.id ?? "",
      },
      actor(),
    );
    // VIOLATION observed: the sandbox completed with ZERO canonical
    // ledger envelopes (the noop ledger recorded nothing).
    expect(noopLedger.eventsOf(EXECUTION_ID)).toHaveLength(0);

    // PRODUCTION: the required seam records admitted + completed.
    const productionLedger = new FakeExecutionLedger();
    productionLedger.seedExecution(EXECUTION_ID, "RUNNING");
    const productionWorld = buildWorld(admission, productionLedger);
    const prodEnvironmentId = (
      await productionWorld.catalog.register(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          slug: "analysis",
          name: "A",
          spec: processSpec,
        },
        "env",
        actor(),
      )
    ).id;
    const admitted = await productionWorld.service.createSandboxExecution(
      { executionId: EXECUTION_ID, environmentId: prodEnvironmentId, task },
      "prod-key",
      actor(),
    );
    await productionWorld.service.dispatchSandboxExecution(
      { applicationId: APPLICATION_ID, sandboxId: admitted.id },
      actor(),
    );
    expect(productionLedger.eventsOf(EXECUTION_ID).map((e) => e.event.command)).toEqual([
      "sandbox-admitted",
      "sandbox-completed",
    ]);
  });
});
