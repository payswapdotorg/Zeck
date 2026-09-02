/**
 * Architecture: the long-running/resumable execution boundary (WORK-028,
 * LNG-001/002/003; checkpoint contracts CONCURRENCY-CRASH-SAFETY,
 * EXECUTION-PROVENANCE).
 *
 * Mechanically proves over the REAL `src/modules/executions/` tree, the
 * sandbox re-admission adapter and migration 0022:
 *
 *  - LG1 the long-running store port carries NO execution-lifecycle
 *    authority (the frozen WORK-006 lifecycle stays THE single status
 *    write path): its METHOD set is exactly the durable-state quartet
 *    {checkpoints, lease, wake-ups, operations}; no transition/create/
 *    append-event vocabulary, no authority type handles;
 *  - LG2 the long-running service deps are pinned: exactly
 *    {executions, store, resumePolicyReadmission, resourceReadmission,
 *    budgetAuthority?, digest, generateId, now} — the REQUIRED
 *    re-admission seams have no default-allow and no extra authority
 *    handles are reachable;
 *  - LG3 the long-running service composes with the FROZEN lifecycle only:
 *    status moves exclusively through `executions.transition` with the
 *    frozen commands (wait-tool/wait-user/wait-human/resume/cancel), all
 *    other evidence rides `executions.recordStepEvent`; there is NO
 *    direct SQL, no store-based status write, no createExecution call
 *    (the identity is never re-created);
 *  - LG4 the frozen lifecycle files stay untouched in vocabulary: the
 *    state machine still owns exactly the frozen TRANSITION_TABLE with no
 *    long-running terms; the additive step-event vocabulary of event.ts is
 *    exactly the six WORK-028 observation commands;
 *  - LG5 migration 0022 is the long-running migration with the full
 *    physical guard set (append-only checkpoints + convergence-aware
 *    gapless sequence gate, guarded lease epochs/heartbeats, write-once
 *    wake-ups, the durable operation state discipline) and the
 *    parallel-wave collision-rule discipline pinned (0015 burned, 0019/
 *    0020 taken by the merged siblings, 0021 claimed by WORK-026,
 *    WORK-028 claims 0022);
 *  - LG6 migration 0022 NEVER writes execution status and never creates a
 *    second event stream: no UPDATE/DELETE against executions.executions,
 *    every table FK-references the EXISTING execution identity, and no
 *    events table exists in it;
 *  - LG7 the long-running domain and ports stay pure: no `src/platform/**`
 *    import in executions domain/ or ports/, no external package imports;
 *  - LG8 the re-admission authority adapters are seam adapters over the
 *    REAL engines through the owner's PUBLIC barrel only (executions'
 *    policy-resume-admission over policies/public; sandbox's
 *    execution-resume-readmission over the sandbox public types + the
 *    REAL admission chain, exported through the sandbox barrel);
 *  - LG9 no rule violations over the executions + sandbox trees (the
 *    shared dependency-rule engine);
 *  - LG10 the executions public barrel exports the long-running surface
 *    (the only import seam for other modules).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { collectSourceFiles } from "./lib/collect";
import { scanDependencyRules } from "./lib/dependency-rules";

const REPO_ROOT = join(process.cwd());
const EXECUTIONS_DIR = join(REPO_ROOT, "src/modules/executions");
const MIGRATION_PATH = join(REPO_ROOT, "src/platform/db/migrations/0022_long_running_execution_state.sql");

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

describe("architecture: the long-running execution boundary (WORK-028)", () => {
  test("LG1: the long-running store port carries NO execution-lifecycle authority", () => {
    const port = read("src/modules/executions/ports/long-running-store.ts");
    for (const forbidden of [
      "transition(",
      "createExecution(",
      "appendEvent(",
      "recordStepEvent(",
      "setExecutionStatus",
      "updateExecution",
      "deleteExecution",
    ]) {
      expect(port.includes(forbidden), `the store port must not carry "${forbidden}"`).toBe(false);
    }
    // Authority type handles never appear as annotations (word-boundary:
    // the port's own LongRunningExecutionStore name is not a violation).
    expect(/\bExecutionService\b|\bExecutionStore\b|\bExecutionAuthorizationPort\b|\bDatabasePort\b/.test(port)).toBe(
      false,
    );
    const interfaceBody = /export interface LongRunningExecutionStore \{([\s\S]*?)\n\}/.exec(port)?.[1] ?? "";
    const methodNames = [...interfaceBody.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*\(/gm)].map(
      (m) => m[1] ?? "",
    );
    expect([...new Set(methodNames)].sort()).toEqual([
      "acquireLease",
      "beginOperation",
      "completeOperation",
      "dueWakeUps",
      "failOperation",
      "findCheckpointByDigest",
      "findOperation",
      "forceReleaseLease",
      "getCheckpoint",
      "getLease",
      "getWakeUp",
      "insertCheckpoint",
      "insertWakeUp",
      "latestCheckpoint",
      "listCheckpoints",
      "listWakeUps",
      "markWakeUpApplied",
      "markWakeUpsSuperseded",
      "pendingWakeUpApplies",
      "recordOperationStage",
      "releaseLease",
      "renewLease",
    ]);
  });

  test("LG2: the long-running service deps are pinned (REQUIRED re-admission seams, no extras)", () => {
    const service = read("src/modules/executions/application/long-running-service.ts");
    const depsMatch = /export interface LongRunningExecutionServiceDeps \{([\s\S]*?)\n\}/.exec(service);
    expect(depsMatch).not.toBeNull();
    const depNames = [...(depsMatch?.[1] ?? "").matchAll(/readonly (\w+)(\?)?:/g)]
      .map((m) => m[1] ?? "")
      .sort();
    expect(depNames).toEqual([
      "budgetAuthority",
      "digest",
      "executions",
      "generateId",
      "now",
      "resourceReadmission",
      "resumePolicyReadmission",
      "store",
    ]);
    // The re-admission seams are REQUIRED (no default-allow exists).
    expect(service.includes("readonly resumePolicyReadmission: ResumePolicyReAdmission;")).toBe(true);
    expect(service.includes("readonly resourceReadmission: ResourceReAdmission;")).toBe(true);
    expect(service.includes("readonly budgetAuthority?: BudgetAuthority;")).toBe(true);
  });

  test("LG3: the long-running service composes with the FROZEN lifecycle only (no second write path, no identity re-creation)", () => {
    const service = read("src/modules/executions/application/long-running-service.ts");
    // Status moves ONLY through the frozen transition commands: the
    // pause's wait-kind ternary (wait-tool | wait-user) + the literals.
    const commands = [...service.matchAll(/command: "(wait-tool|wait-user|wait-human|resume|cancel)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect([...new Set(commands)].sort()).toEqual(["cancel", "resume", "wait-human"]);
    expect(
      service.includes('command: input.waitKind === "tool" ? "wait-tool" : "wait-user"'),
    ).toBe(true);
    for (const forbidden of [
      "createExecution(",
      "INSERT INTO",
      "UPDATE ",
      "DELETE FROM",
      "updateExecutionForTransition",
    ]) {
      expect(service.includes(forbidden), `the service must not carry "${forbidden}"`).toBe(false);
    }
    // Every lifecycle move goes through the composed frozen service
    // (pause, resume, interrupt, terminate, workerTransition).
    expect((service.match(/executions\.transition\(/g) ?? []).length).toBe(5);
    // All other evidence rides the canonical ledger seam — one wrapper
    // call site, ten governed evidence records through it.
    expect((service.match(/executions\.recordStepEvent\(/g) ?? []).length).toBe(1);
    expect((service.match(/recordEvidence\(/g) ?? []).length).toBe(10);
    expect(service.includes("executions.recordStepEvent(")).toBe(true);
  });

  test("LG4: the frozen lifecycle vocabulary is untouched; the additive step-event vocabulary is exactly the WORK-028 six", () => {
    const stateMachine = read("src/modules/executions/domain/state-machine.ts");
    // The frozen transition-command vocabulary stays authoritative.
    expect(stateMachine.includes("export const EXECUTION_COMMANDS")).toBe(true);
    expect(stateMachine.includes("export const TRANSITION_TABLE")).toBe(true);
    for (const frozenCommand of [
      '"authorize"',
      '"plan"',
      '"replan"',
      '"queue"',
      '"start"',
      '"wait-tool"',
      '"wait-user"',
      '"wait-human"',
      '"resume"',
      '"verify"',
      '"pass"',
      '"fail"',
      '"cancel"',
      '"expire"',
    ]) {
      expect(stateMachine.includes(frozenCommand), `${frozenCommand} must stay in the frozen table`).toBe(true);
    }
    // No long-running term leaked into the frozen machine.
    for (const leaked of [
      "checkpoint",
      "lease",
      "wake",
      "heartbeat",
      "longrunning",
      "LONG_RUNNING",
    ]) {
      expect(stateMachine.includes(leaked), `the frozen machine must not carry "${leaked}"`).toBe(false);
    }
    // The additive vocabulary is exactly six observation commands.
    const event = read("src/modules/executions/domain/event.ts");
    const block = /WORK-028 \(long-running executions\)[\s\S]*?] as const;/.exec(event)?.[0] ?? "";
    for (const command of [
      '"checkpoint-recorded"',
      '"interruption-requested"',
      '"wake-up-scheduled"',
      '"wake-up-applied"',
      '"resume-recorded"',
      '"resume-denied"',
    ]) {
      expect(block.includes(command), `the additive vocabulary must include ${command}`).toBe(true);
    }
    expect((block.match(/"/g) ?? []).length).toBe(12); // exactly the 6 command literals
  });

  test("LG5: migration 0022 is the long-running migration with the physical guard set + the collision discipline", () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    expect(migration.includes("executions.execution_checkpoints")).toBe(true);
    expect(migration.includes("executions.execution_leases")).toBe(true);
    expect(migration.includes("executions.execution_wakeups")).toBe(true);
    expect(migration.includes("executions.execution_operations")).toBe(true);
    for (const guard of [
      "lr_checkpoints_no_mutation",
      "lr_checkpoint_sequence_gate",
      "lr_lease_guards",
      "lr_lease_no_delete",
      "lr_lease_insert_gate",
      "lr_wakeups_guards",
      "lr_wakeups_no_delete",
      "lr_ops_core_guard",
      "lr_ops_lifecycle_guard",
      "lr_ops_no_delete",
      "lr_checkpoint_sequence_unique",
      "lr_wakeup_key_unique",
      "lr_ops_key_unique",
      "lr_wakeups_due_order",
      "lr_ops_pending_scan",
    ]) {
      expect(migration.includes(guard), `guard ${guard} must exist`).toBe(true);
    }
    // The convergence-aware gate (same digest converges, different digest
    // fails closed) and the crash-safety discipline markers.
    expect(migration.includes("IF existing_digest = NEW.content_digest THEN RETURN NEW;")).toBe(true);
    expect(migration.includes("terminal rows fully")).toBe(true);
    // The parallel-wave collision discipline is pinned in the file
    // (comment line breaks are respected — each claim phrase pinned).
    expect(migration.includes("is BURNED")).toBe(true);
    expect(migration.includes("WORK-028 claims 0022")).toBe(true);
    expect(migration.includes("0019 = WORK-021,")).toBe(true);
    expect(migration.includes("WORK-025). The sibling WORK-026 claims 0021")).toBe(true);
  });

  test("LG6: migration 0022 never writes execution status and never creates a second event stream", () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    // No status write, no execution-row mutation anywhere in the migration.
    expect(/UPDATE\s+executions\.executions/i.test(migration)).toBe(false);
    expect(/DELETE\s+FROM\s+executions\.executions/i.test(migration)).toBe(false);
    // No second event stream: only status SELECTs into the guard functions.
    const executionRefs = [...migration.matchAll(/executions\.executions/g)].length;
    expect(executionRefs).toBeGreaterThanOrEqual(2);
    // Every table references the EXISTING execution identity (composite FK).
    for (const fk of [
      "lr_checkpoint_execution_fk",
      "lr_lease_execution_fk",
      "lr_wakeup_execution_fk",
      "lr_ops_execution_fk",
    ]) {
      expect(migration.includes(fk), `FK ${fk} must bind the existing identity`).toBe(true);
    }
    expect(/CREATE TABLE [^\n]*events/i.test(migration)).toBe(false);
    expect(migration.includes("execution_events")).toBe(false);
  });

  test("LG7: the long-running domain and ports stay pure (no platform, no external packages)", () => {
    const violations: string[] = [];
    for (const relative of [
      "src/modules/executions/domain/checkpoint.ts",
      "src/modules/executions/domain/lease.ts",
      "src/modules/executions/domain/longrunning.ts",
      "src/modules/executions/domain/wakeup.ts",
      "src/modules/executions/ports/long-running-store.ts",
      "src/modules/executions/ports/resume-admission.ts",
    ]) {
      const text = read(relative);
      if (/from ["'](\.\.\/)+\.\.\/(\.\.\/)?platform\//.test(text)) {
        violations.push(`${relative}: platform import`);
      }
      if (/from ["'](@[a-z]|\bpg\b|fastify)["']/.test(text)) {
        violations.push(`${relative}: external package import`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("LG8: the re-admission adapters are seam adapters over the REAL engines (public barrels only)", () => {
    const policyAdapter = read("src/modules/executions/adapters/policy-resume-admission.ts");
    expect(policyAdapter.includes('from "../../policies/public"')).toBe(true);
    expect(policyAdapter.includes("ResumePolicyReAdmission")).toBe(true);
    expect(/INSERT|UPDATE |DELETE FROM/i.test(policyAdapter)).toBe(false);
    const sandboxAdapter = read("src/modules/sandbox/adapters/execution-resume-readmission.ts");
    expect(sandboxAdapter.includes('from "../../executions/public"')).toBe(true);
    expect(sandboxAdapter.includes("ResourceReAdmission")).toBe(true);
    expect(sandboxAdapter.includes("createExecutionResumeReadmission")).toBe(true);
    // It consults the REAL catalog + admission chain (the current state,
    // never a snapshot) and holds no decision logic of its own beyond
    // fact mapping.
    expect(sandboxAdapter.includes("catalog.get(")).toBe(true);
    expect(sandboxAdapter.includes("admission.admit(")).toBe(true);
    expect(/INSERT|UPDATE |DELETE FROM/i.test(sandboxAdapter)).toBe(false);
    // The sandbox barrel exports the seam.
    expect(read("src/modules/sandbox/public.ts").includes("createExecutionResumeReadmission")).toBe(true);
    expect(read("src/modules/sandbox/adapters/index.ts").includes("execution-resume-readmission")).toBe(true);
  });

  test("LG9: no rule violations over the executions + sandbox trees (the shared engine)", () => {
    const files = collectSourceFiles(REPO_ROOT);
    const violations = scanDependencyRules(files, { allowedPackages: ["fastify"] });
    const relevant = violations.filter(
      (v) => v.path.startsWith("src/modules/executions") || v.path.startsWith("src/modules/sandbox"),
    );
    expect(relevant.map((v) => `${v.rule} @ ${v.path}`)).toEqual([]);
  });

  test("LG10: the executions public barrel exports the long-running surface (the only import seam)", () => {
    const publicBarrel = read("src/modules/executions/public.ts");
    // The executions-module barrel convention: services + domain surface
    // cross the barrel (store adapters stay module-internal, exactly as
    // the frozen WORK-006 SqlExecutionStore precedent).
    for (const exported of [
      "createLongRunningExecutionService",
      "LongRunningExecutionServiceDeps",
      "LongRunningExecutionService",
      "longRunningOperationKey",
      "executionScopedDiscriminator",
      "checkpointIntegrityFailure",
      "checkpointIncompatibility",
      "materialChangeBetween",
      "validateCheckpointContents",
      "validateResumeFacts",
      "leaseGuardRejection",
      "classifyLease",
      "compareWakeUpOrder",
      "ResumePolicyReAdmission",
      "ResourceReAdmission",
    ]) {
      expect(publicBarrel.includes(exported), `${exported} must cross the barrel`).toBe(true);
    }
  });

  test("LG11: the SQL store stays inside the executions module and rides the platform DatabasePort only", () => {
    const sqlStore = read("src/modules/executions/adapters/sql-long-running-store.ts");
    expect(sqlStore.includes('from "../../../platform/db/port"')).toBe(true);
    // Only the extension tables of migration 0022 + read-only executions
    // references (the frozen identity is never written here).
    for (const table of [
      "executions.execution_checkpoints",
      "executions.execution_leases",
      "executions.execution_wakeups",
      "executions.execution_operations",
    ]) {
      expect(sqlStore.includes(table), `the store must own ${table}`).toBe(true);
    }
    const writesExecutions = /UPDATE\s+executions\.executions|DELETE\s+FROM\s+executions\.executions/i.test(
      sqlStore,
    );
    expect(writesExecutions).toBe(false);
  });
});
