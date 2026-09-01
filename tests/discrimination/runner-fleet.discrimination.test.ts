/**
 * Discrimination: the runner-fleet boundary (WORK-019 CRITICAL boundaries;
 * checkpoint contracts IMPLEMENTATION-COMPLETENESS, IDENTITY-IDEMPOTENCY,
 * CONCURRENCY-CRASH-SAFETY, SELF-HOSTING-BOUNDARY).
 *
 * Every explicitly named M1..M20 boundary is proven by a mutant that
 * removes it — a weakened implementation FAILS the corresponding proof:
 *
 *   STATIC MUTANTS (the shared scanner over mutated REAL source — the
 *   WORK-006/007/010/011/012 red-record pattern; the architecture gate
 *   runs the same scanner over the real tree, so it fails under exactly
 *   these mutations):
 *     M1  the runner/sandbox tenant guard deleted
 *     M2  the actor application scope guard deleted / store reads lose
 *         their application qualification
 *     M3  the unregistered-runner null check deleted
 *     M4  the authorization gate deleted (assignment AND report-time)
 *     M5  the capability requirement match deleted / the typed denial
 *         dropped (M8 shares the protection)
 *     M6  the admitted-parent (dispatching) anchor deleted
 *     M7  an authority seam added to the fleet deps
 *     M9  an executions import / execution-creation surface appears
 *     M10 the assignment ON CONFLICT convergence deleted
 *     M11 the reconnect re-bind replaced by an insert path
 *     M12 the same-statement heartbeat/health guard deleted
 *     M13 a direct execution-lifecycle write appears
 *     M14 a VM vendor type leaks into a public contract
 *     M15 a second execution state machine / authority appears
 *     M16 registration starts trusted (default-authorized)
 *     M17 a secret VALUE field / raw-token storage appears
 *     M18 the reconnect event / append-only trail deleted
 *     M19 the split-brain partial unique index removed (migration)
 *     M20 the same-statement health guard weakened
 *
 *   RUNTIME RED RECORDS (the REAL production composition rejecting
 *   hostile inputs — the violation is the hypothetical acceptance, the
 *   production behavior is the refusal): cross-tenant assignment,
 *   unregistered runner, revoked runner report, capability mismatch,
 *   stale heartbeat, parent-identity mismatch, reconnect duplication,
 *   secret-free handoff, registration-not-trust. The PostgreSQL halves
 *   (true concurrency, crash safety, split-brain physicality) live in
 *   tests/integration/postgres/runner-fleet*.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PlatformError } from "../../src/shared/errors";
import {
  attachEndpoint,
  createRunnerFleetWorld,
  type RunnerFleetWorld,
} from "../unit/sandbox/runner-fakes";
import {
  hasCanonicalRunnerFabric,
  type RunnerFleetFile,
  runnerFleetViolations,
} from "./lib/runners";

const REPO_ROOT = join(process.cwd());

function realTree(): RunnerFleetFile[] {
  const files: RunnerFleetFile[] = [];
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
  walk("src/integrations/runners");
  files.push({
    path: "src/platform/db/migrations/0015_runner_fleet.sql",
    content: readFileSync(
      join(REPO_ROOT, "src/platform/db/migrations/0015_runner_fleet.sql"),
      "utf-8",
    ),
  });
  return files;
}

function mutate(
  tree: RunnerFleetFile[],
  path: string,
  replacement: (content: string) => string,
): RunnerFleetFile[] {
  return tree.map((file) =>
    file.path === path ? { ...file, content: replacement(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// Static mutants (the shared scanner must flag each removal)
// ---------------------------------------------------------------------------

describe("discrimination: static runner-fleet mutants", () => {
  test("scanner honesty: the unmutated real tree yields ZERO violations", () => {
    const tree = realTree();
    expect(hasCanonicalRunnerFabric(tree)).toBe(true);
    expect(runnerFleetViolations(tree)).toEqual([]);
  });

  test("M1: the runner tenant guard deleted (cross-tenant assignment accepted)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) => content.replaceAll("runner.tenantId !== actor.tenantId", "false"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-tenant-check-missing");
  });

  test("M1b: the sandbox-parent tenant guard deleted", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) => content.replaceAll("sandbox.tenantId !== actor.tenantId", "false"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-tenant-check-missing");
  });

  test("M2: the actor application scope guard deleted", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) => content.replaceAll("actor.applicationId !== applicationId", "false"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-actor-scope-missing");
  });

  test("M2b: the SQL store reads losing their application qualification", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/sql-runner-store.ts",
      (content) =>
        content.replaceAll(
          "WHERE application_id = $1 AND assignment_key = $2",
          "WHERE assignment_key = $2",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-scope-qualified-queries-missing");
  });

  test("M3: the unregistered-runner check deleted (silent auto-accept)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) => content.replaceAll("if (runner === null) {", "if (false) {"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-unregistered-check-missing");
  });

  test("M4: the authorization gate before assignment deleted (revoked accepted)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace('if (runner.authorizationStatus !== "authorized") {', "if (false) {"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-revoked-check-missing");
  });

  test("M4b: the report-time authorization re-check deleted", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          "message:\n          \"the runner's authorization is not valid at report time",
          'message:\n          "',
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-report-time-authorization-missing");
  });

  test("M5/M8: the capability requirement match deleted (unauthorized capability accepted)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          "if (!runnerSupportsRequirements(runner.declaredCapabilities, requiredCapabilities)) {",
          "if (false) {",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-capability-match-missing");
  });

  test("M5b/M8b: the typed capability denial dropped", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) => content.replaceAll('"CAPABILITY_UNAVAILABLE"', '"SANDBOX_ERROR"'),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-capability-match-missing");
  });

  test("M6: the admitted-parent anchor deleted (assignment without admission)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) => content.replace('if (sandbox.status !== "dispatching") {', "if (false) {"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-pre-admission-assignment-missing");
  });

  test("M7: an authority seam added to the fleet deps (policy/budget bypass surface)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          "export interface RunnerFleetDeps {",
          "export interface RunnerFleetDeps {\n  readonly policy: { readonly bypass: boolean };",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-fleet-authority-seam");
  });

  test("M7b: the budget seam added to the fleet deps", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          "export interface RunnerFleetDeps {",
          "export interface RunnerFleetDeps {\n  readonly budgetAuthority: unknown;",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-fleet-authority-seam");
  });

  test("M9: an executions import / execution-creation surface appears (second identity)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          'import type { SandboxStore } from "../ports/sandbox-store";',
          'import type { SandboxStore } from "../ports/sandbox-store";\nimport type { ExecutionService } from "../../executions/public";\nconst executionService: ExecutionService | null = null;\nvoid executionService;',
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-execution-creation-surface");
  });

  test("M9b: the integration importing the executions authority", () => {
    const mutant = mutate(
      realTree(),
      "src/integrations/runners/application/customer-runner-gateway.ts",
      (content) =>
        content.replace(
          'import type { ExternalRunnerRegistration } from "../domain/submission";',
          'import type { ExternalRunnerRegistration } from "../domain/submission";\nimport type { ExecutionService } from "../../../modules/executions/public";\nconst executionService: ExecutionService | null = null;\nvoid executionService;',
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-execution-creation-surface");
  });

  test("M10: the assignment unique-key convergence deleted (duplicate assignment)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/sql-runner-store.ts",
      (content) => content.replace("ON CONFLICT DO NOTHING\nRETURNING", "RETURNING"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-no-convergence");
  });

  test("M10b: the idempotency reuse rejection dropped", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) => content.replaceAll('"IDEMPOTENCY_KEY_REUSED"', '"SANDBOX_ERROR"'),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-idempotency-reuse-missing");
  });

  test("M11: the reconnect re-bind replaced by a new-assignment insert", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          "const assignment = await store.recordRunnerReconnect({",
          "const assignment = await store.insertRunnerAssignment({",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-reconnect-rebind-missing");
  });

  test("M11b: the reconnect event append deleted (provenance lost across reconnect)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) => content.replace('"reconnected"', '"observed"'),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-provenance-trail-missing");
  });

  test("M12: the same-statement heartbeat guard deleted (stale runner assigned)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/sql-runner-store.ts",
      (content) => content.replace("AND r.last_heartbeat_at >= $16", "AND true"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-health-guard-missing");
  });

  test("M12b: the service health-eligibility gate deleted", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          "if (!isRunnerHealthyForAssignment(runner, nowMs(), deps.heartbeatWindowMs)) {",
          "if (false) {",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-health-gate-missing");
  });

  test("M13: a direct execution-lifecycle write appears in the fleet", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          "const requireRunner = async (",
          "await store.execute?.({ sql: 'UPDATE executions.executions SET status = 1' });\n  const requireRunner = async (",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-writes-execution-lifecycle");
  });

  test("M14: a VM vendor type leaks into the sandbox public barrel", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/public.ts", (content) =>
      content.replace(
        "export const moduleDescriptor",
        "export type FirecrackerMicroVmConfig = { machineType: string };\nexport const moduleDescriptor",
      ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-vm-vendor-vocabulary");
  });

  test("M14b: a VM vendor vocabulary leaks into the neutral runtime port", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/ports/isolated-runtime.ts", (content) =>
      content.replace(
        "export interface IsolatedImageRuntime {",
        "export interface IsolatedImageRuntime {\n  readonly qemuMachineType?: string;",
      ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-vm-vendor-vocabulary");
  });

  test("M15: a second execution state machine appears in the runner domain", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/domain/runner.ts", (content) =>
      content.replace(
        "export const RUNNER_ASSIGNMENT_STATUSES = [",
        'export const RUNNER_EXECUTION_STATES = ["CREATED", "RUNNING"] as const;\n\nexport const RUNNER_ASSIGNMENT_STATUSES = [',
      ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-execution-status-vocabulary");
  });

  test("M15b: a second authority interface appears in the runner domain", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/domain/runner.ts", (content) =>
      content.replace(
        "export const RUNNER_CAPABILITY_IDS = [",
        "export interface PolicyAuthority {\n  decideEverything(): boolean;\n}\n\nexport const RUNNER_CAPABILITY_IDS = [",
      ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-second-authority");
  });

  test("M16: registration starts trusted (default-authorized runner)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/in-memory-runner-store.ts",
      (content) =>
        content.replace('authorizationStatus: "untrusted",', 'authorizationStatus: "authorized",'),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-default-trusted");
  });

  test("M16b: the authorize transition guard opened (any state authorizes)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/sql-runner-store.ts",
      (content) =>
        content.replace(
          "WHERE application_id = $3 AND id = $4 AND authorization_status = 'untrusted'",
          "WHERE application_id = $3 AND id = $4",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-authorization-transition-open");
  });

  test("M17: a secret VALUE field appears on the runner handoff", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/domain/runner.ts", (content) =>
      content.replace(
        "readonly secretRefs: readonly string[];\n  readonly leaseExpiresAt: string;",
        "readonly secretRefs: readonly string[];\n  readonly secretValues: readonly string[];\n  readonly leaseExpiresAt: string;",
      ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-secret-field");
  });

  test("M17b: the raw registration token stored instead of its fingerprint", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replace(
          "const tokenFingerprint = hashToken(input.registrationToken);",
          "const tokenFingerprint = input.registrationToken;",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-raw-token-storage");
  });

  test("M18: the append-only evidence trail deleted from the migration", () => {
    const mutant = mutate(
      realTree(),
      "src/platform/db/migrations/0015_runner_fleet.sql",
      (content) =>
        content.replace(
          "CREATE TRIGGER runner_assignment_events_no_update",
          "CREATE TRIGGER runner_assignment_events_no_update_disabled",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-provenance-trail-missing");
  });

  test("M19: the split-brain partial unique index removed (release race)", () => {
    const mutant = mutate(
      realTree(),
      "src/platform/db/migrations/0015_runner_fleet.sql",
      (content) =>
        content.replace(
          "CREATE UNIQUE INDEX runner_assignments_active_slot",
          "CREATE INDEX runner_assignments_active_slot",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-active-slot-guard-missing");
  });

  test("M19b: the assignment idempotency key uniqueness removed", () => {
    const mutant = mutate(
      realTree(),
      "src/platform/db/migrations/0015_runner_fleet.sql",
      (content) =>
        content.replace(
          "CONSTRAINT runner_assignments_request_key UNIQUE (application_id, assignment_key)",
          "CONSTRAINT runner_assignments_request_key UNIQUE (application_id, id)",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-assignment-key-unique-missing");
  });

  test("M20: the same-statement health guard weakened (dead runner assigned)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/adapters/sql-runner-store.ts",
      (content) =>
        content.replace("AND r.health_status = 'healthy'", "AND r.health_status <> 'unhealthy'"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-health-guard-missing");
  });

  test("M20b: the connect-time revocation guard deleted (revoked runner reconnects)", () => {
    const mutant = mutate(
      realTree(),
      "src/modules/sandbox/application/runner-fleet.ts",
      (content) =>
        content.replaceAll('if (runner.authorizationStatus === "revoked") {', "if (false) {"),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-reconnect-revocation-missing");
  });

  test("M16c: the integration holding its own runner registry (second authority)", () => {
    const mutant = mutate(
      realTree(),
      "src/integrations/runners/application/customer-runner-gateway.ts",
      (content) =>
        content.replace(
          "export function createCustomerRunnerGateway(",
          "const runnerRegistry = new Map<string, unknown>();\n\nexport function createCustomerRunnerGateway(",
        ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-integration-holds-registry");
  });

  test("M13b: the runner store port gaining an execution transition surface", () => {
    const mutant = mutate(realTree(), "src/modules/sandbox/ports/runner-store.ts", (content) =>
      content.replace(
        "  // ---- append-only evidence ----",
        "  transitionExecution(executionId: string): Promise<void>;\n  // ---- append-only evidence ----",
      ),
    );
    expect(runnerFleetViolations(mutant)).toContain("runner-execution-lifecycle-coupling");
  });
});

// ---------------------------------------------------------------------------
// Runtime red records (the REAL production composition, hostile inputs)
// ---------------------------------------------------------------------------

const REQUIRED = ["customer-runner", "cpu", "memory"];

function expectCode(promise: Promise<unknown>, code: string): Promise<PlatformError> {
  return promise.then(
    () => {
      throw new Error(`expected a PlatformError with code ${code}, got a resolution`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
      return error as PlatformError;
    },
  );
}

async function readyWorld(): Promise<{
  world: RunnerFleetWorld;
  environmentId: string;
  runnerId: string;
  ids: { sandboxId: string; executionId: string };
}> {
  const world = createRunnerFleetWorld();
  const environmentId = await world.registerEnvironment();
  const runnerId = await world.registerRunner(environmentId);
  const ids = await world.seedSandbox(environmentId);
  return { world, environmentId, runnerId, ids };
}

describe("discrimination: runtime red records (hostile inputs, production wiring)", () => {
  test("R-M1: a cross-tenant actor cannot assign a runner (TENANT_SCOPE_VIOLATION)", async () => {
    const { world, environmentId, runnerId, ids } = await readyWorld();
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "r-m1",
        {
          actorId: "00000000-0000-7000-8000-0000000000c1",
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          tenantId: "00000000-0000-7000-8000-0000000000a2",
        },
      ),
      "TENANT_SCOPE_VIOLATION",
    );
  });

  test("R-M3: an unregistered runner id is a typed scope rejection, never an assignment", async () => {
    const { world, environmentId, ids } = await readyWorld();
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId: "00000000-0000-7000-8000-0000000000f9",
          requiredCapabilities: REQUIRED,
        },
        "r-m3",
        world.actor(),
      ),
      "TENANT_SCOPE_VIOLATION",
    );
  });

  test("R-M4: a revoked runner cannot land a result report (the outcome never lands)", async () => {
    const { world, environmentId, runnerId, ids } = await readyWorld();
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "r-m4",
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId: assignment.id },
      world.actor(),
    );
    // The store-level race shape: revoked without the service sweep.
    await world.runnerStore.revokeRunner({
      applicationId: "00000000-0000-7000-8000-0000000000b1",
      runnerId,
      reason: "hostile",
      revokedAt: world.now().toISOString(),
    });
    await expectCode(
      world.fleet.reportResult(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          assignmentId: assignment.id,
          report: {
            outcomeClass: "sandbox-success",
            outputDigest: null,
            output: null,
            usageMicroUsd: null,
            failure: null,
          },
        },
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
  });

  test("R-M5/M8: a capability mismatch is refused before any durable write", async () => {
    const { world, environmentId, ids } = await readyWorld();
    const runnerId = await world.registerRunner(environmentId, {
      declaredCapabilities: ["customer-runner", "cpu"],
    });
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: ["customer-runner", "gpu"],
        },
        "r-m5",
        world.actor(),
      ),
      "CAPABILITY_UNAVAILABLE",
    );
    expect(
      await world.fleet.getAssignmentByKey("00000000-0000-7000-8000-0000000000b1", "r-m5"),
    ).toBeNull();
  });

  test("R-M12: a stale heartbeat makes the runner unassignable (dead runners get no work)", async () => {
    const { world, environmentId, runnerId, ids } = await readyWorld();
    world.setNow(new Date(Date.parse(world.now().toISOString()) + 31_000));
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "r-m12",
        world.actor(),
      ),
      "NO_ELIGIBLE_ROUTE",
    );
  });

  test("R-M9: a forged execution identity against a sandbox parent is refused (no second identity)", async () => {
    const { world, environmentId, runnerId, ids } = await readyWorld();
    const error = await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: "00000000-0000-7000-8000-0000000000e1",
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "r-m9",
        world.actor(),
      ),
      "SANDBOX_ERROR",
    );
    expect(error.message).toContain("does not match the parent sandbox execution");
    expect(
      await world.fleet.listAssignmentsByExecution(
        "00000000-0000-7000-8000-0000000000b1",
        "00000000-0000-7000-8000-0000000000e1",
      ),
    ).toHaveLength(0);
  });

  test("R-M11: repeated reconnects re-bind the SAME assignment — no second execution is minted", async () => {
    const { world, environmentId, runnerId, ids } = await readyWorld();
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "r-m11",
      world.actor(),
    );
    await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId: assignment.id },
      world.actor(),
    );
    for (let i = 0; i < 3; i += 1) {
      const { assignment: reconnected } = await world.fleet.reconnectRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          runnerId,
          registrationToken: "runner-registration-token-0001",
        },
        world.actor(),
      );
      expect(reconnected?.id).toBe(assignment.id);
    }
    const byExecution = await world.fleet.listAssignmentsByExecution(
      "00000000-0000-7000-8000-0000000000b1",
      ids.executionId,
    );
    expect(byExecution).toHaveLength(1);
    expect(byExecution[0]?.reconnectCount).toBe(3);
    const events = await world.fleet.listAssignmentEvents(
      "00000000-0000-7000-8000-0000000000b1",
      assignment.id,
    );
    expect(events.filter((e) => e.event === "reconnected")).toHaveLength(3);
    // Provenance survived every reconnect (M18).
    expect(events[0]?.event).toBe("assigned");
    expect(byExecution[0]?.provenance.executionId).toBe(ids.executionId);
  });

  test("R-M16: a freshly registered runner serves NOTHING (registration is not trust)", async () => {
    const { world, environmentId, ids } = await readyWorld();
    const runnerId = await world.registerRunner(environmentId, { authorize: false });
    await expectCode(
      world.fleet.assignRunner(
        {
          applicationId: "00000000-0000-7000-8000-0000000000b1",
          executionId: ids.executionId,
          sandboxId: ids.sandboxId,
          environmentId,
          runnerId,
          requiredCapabilities: REQUIRED,
        },
        "r-m16",
        world.actor(),
      ),
      "AUTHORIZATION_DENIED",
    );
  });

  test("R-M17: the handoff that crosses the boundary carries references only — never credentials", async () => {
    const world = createRunnerFleetWorld();
    const environmentId = await world.registerEnvironment();
    const runnerId = await world.registerRunner(environmentId);
    const endpoint = attachEndpoint(world, runnerId);
    const ids = await world.seedSandbox(environmentId);
    const assignment = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "r-m17",
      world.actor(),
    );
    const handoff = await world.fleet.dispatchAssignment(
      { applicationId: "00000000-0000-7000-8000-0000000000b1", assignmentId: assignment.id },
      world.actor(),
    );
    const serialized = JSON.stringify(handoff);
    expect(serialized).not.toContain("runner-registration-token");
    expect(serialized).not.toContain("tokenFingerprint");
    expect(serialized).not.toContain("sk-");
    expect(handoff.secretRefs).toEqual([]);
    // The remote endpoint never receives the runner identity secret either.
    expect(JSON.stringify(endpoint)).not.toContain("runner-registration-token-0001");
  });

  test("R-M19: a released runner's slot frees exactly one assignment (no second active row)", async () => {
    const { world, environmentId, runnerId, ids } = await readyWorld();
    const first = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: ids.executionId,
        sandboxId: ids.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "r-m19-a",
      world.actor(),
    );
    await world.fleet.releaseAssignment(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        assignmentId: first.id,
        reason: "operator-release",
      },
      world.actor(),
    );
    // After the release, a NEW assignment may claim the freed slot —
    // exactly ONE active row exists at any time.
    const secondIds = await world.seedSandbox(environmentId);
    const second = await world.fleet.assignRunner(
      {
        applicationId: "00000000-0000-7000-8000-0000000000b1",
        executionId: secondIds.executionId,
        sandboxId: secondIds.sandboxId,
        environmentId,
        runnerId,
        requiredCapabilities: REQUIRED,
      },
      "r-m19-b",
      world.actor(),
    );
    expect(second.status).toBe("assigned");
    const active = await world.fleet.listRunners("00000000-0000-7000-8000-0000000000b1");
    expect(active).toHaveLength(1);
    const byRunner = await world.runnerStore.findActiveAssignmentByRunner(
      "00000000-0000-7000-8000-0000000000b1",
      runnerId,
    );
    expect(byRunner?.id).toBe(second.id);
    expect(byRunner?.status).toBe("assigned");
  });
});
