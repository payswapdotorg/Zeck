/**
 * The PPR-021 corpus runner — drives the REAL pinned Continue runtime
 * (the CLI headless mode for the agent-loop tasks; the core role APIs
 * for the IDE-role tasks) through the Zeck adapter inside the proof
 * environment (egress-deny proxy + preload + credential-scrubbed
 * allowlist environment + CONTINUE_GLOBAL_DIR isolation with the
 * role-model config.yaml), verifies each task mechanically, and records
 * the per-task facts (edge executions, egress violations, rail usage).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EgressViolation } from "../../../src/integrations/compatibility/public";
import type { AdapterRequestLog, AdapterServer } from "../adapter/server";
import type { CorpusTask } from "../corpus/tasks";
import type { EgressProxy } from "./egress-proxy";
import { runContinue } from "./runtime-spawn";
import type { RailExecutionFact } from "./compose";

/** One corpus task's run outcome (the battery's runtime evidence). */
export interface CorpusTaskOutcome {
  readonly taskId: string;
  readonly title: string;
  readonly resolved: boolean;
  readonly checkOutput: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly timedOut: boolean;
  readonly driverOk: boolean;
  /** The honest BLOCKED unavailability, when the task declared one. */
  readonly blocked: { readonly cause: string; readonly owner: string } | null;
  readonly edgeExecutions: readonly {
    readonly edgeId: string;
    readonly executionId: string;
    readonly replayed: boolean;
  }[];
  readonly egressViolations: readonly EgressViolation[];
  readonly railUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly dispatches: number;
    readonly failures: number;
  };
}

export interface CorpusRunnerOptions {
  readonly adapter: AdapterServer;
  readonly proxy: EgressProxy;
  readonly workspaceRoot: string;
  /** The rail facts accessor (the composed stack's telemetry). */
  readonly railFacts: () => readonly RailExecutionFact[];
  /** Per-run wall-clock timeout (ms). Default 420_000. */
  readonly runTimeoutMs?: number;
  /** Pause between tasks (supply pacing). */
  readonly interTaskDelayMs?: number;
}

function tailOf(text: string, maxChars = 1600): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/** Run the whole corpus (or a task subset) and return per-task outcomes. */
export async function runCorpus(
  options: CorpusRunnerOptions,
  tasks: readonly CorpusTask[],
): Promise<readonly CorpusTaskOutcome[]> {
  const outcomes: CorpusTaskOutcome[] = [];
  for (const [index, task] of tasks.entries()) {
    if (index > 0 && (options.interTaskDelayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.interTaskDelayMs));
    }
    outcomes.push(await runOneTask(options, task));
  }
  return outcomes;
}

async function runOneTask(
  options: CorpusRunnerOptions,
  task: CorpusTask,
): Promise<CorpusTaskOutcome> {
  const startedAt = Date.now();
  const workdir = join(options.workspaceRoot, task.taskId);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  task.fixture(workdir);

  // The per-run isolated home + egress log.
  const homeDir = join(options.workspaceRoot, `${task.taskId}.home`);
  rmSync(homeDir, { recursive: true, force: true });
  const egressLogPath = join(options.workspaceRoot, `${task.taskId}.egress.jsonl`);

  let roleSpecPath: string | undefined;
  if (task.driver === "role" && task.role !== undefined) {
    const spec = {
      task_id: task.taskId,
      workspace: workdir,
      home: homeDir,
      continue_root: process.env.PPR_021_CONTINUE_ROOT ?? "/home/z/my-project/continue",
      action: task.role.action,
      ...(task.role.file === undefined ? {} : { file: task.role.file }),
      ...(task.role.instruction === undefined ? {} : { instruction: task.role.instruction }),
      ...(task.role.new_code === undefined ? {} : { new_code: task.role.new_code }),
      ...(task.role.range_start === undefined ? {} : { range_start: task.role.range_start }),
      ...(task.role.range_end === undefined ? {} : { range_end: task.role.range_end }),
      ...(task.role.position === undefined ? {} : { position: task.role.position }),
      ...(task.role.embed_inputs === undefined ? {} : { embed_inputs: task.role.embed_inputs }),
      ...(task.role.query === undefined ? {} : { query: task.role.query }),
      ...(task.role.documents === undefined ? {} : { documents: task.role.documents }),
    };
    roleSpecPath = join(options.workspaceRoot, `${task.taskId}.spec.json`);
    writeFileSync(roleSpecPath, JSON.stringify(spec, null, 2));
  }

  const violationsBefore = options.proxy.violations().length;
  const railBefore = new Set(options.railFacts().map((fact) => fact.attemptId));
  const adapterBefore = options.adapter.requests().length;
  options.adapter.setRunContext({ corpusTask: task.taskId, runLabel: task.taskId });

  const result = await runContinue({
    driver: task.driver,
    cwd: workdir,
    homeDir,
    adapterBaseUrl: options.adapter.url,
    proxyUrl: options.proxy.url,
    egressLogPath,
    timeoutMs: options.runTimeoutMs ?? 420_000,
    ...(task.driver === "cli"
      ? {
          cliInstruction: task.cli?.instruction ?? "",
          cliFlags: task.cli?.flags ?? [],
          ...(task.cli?.mode === "serve" ? { cliMode: "serve" as const } : {}),
        }
      : { roleSpecPath }),
  });
  options.adapter.setRunContext(null);

  // The attributed edge executions of THIS run (computed before verify so
  // a task's mechanical verification can require delegation evidence —
  // e.g. the subagent task resolves only when the child-session edge
  // actually executed through Zeck).
  const newLogs: readonly AdapterRequestLog[] = options.adapter.requests().slice(adapterBefore);
  const runEdgeExecutions = newLogs.map((log) => ({
    edgeId: log.edgeId,
    executionId: log.executionId,
    replayed: log.replayed,
  }));

  const verification = task.verify({
    workdir,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    edgeExecutions: runEdgeExecutions,
  });

  const newRailFacts = options.railFacts().filter((fact) => !railBefore.has(fact.attemptId));
  const violations = [
    ...options.proxy.violations().slice(violationsBefore),
    ...result.preloadViolations,
  ];

  // The driver's machine-readable result.
  let driverOk = result.exitCode === 0;
  if (task.driver === "role") {
    const line = result.stdout
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("CONTINUE_ROLE_RESULT:"));
    driverOk = driverOk && line !== undefined;
  }

  console.log(
    `[ppr-021 corpus] ${task.taskId}: ${verification.resolved ? "RESOLVED" : verification.blocked !== undefined ? "BLOCKED" : "UNRESOLVED"} ` +
      `(${((Date.now() - startedAt) / 1000).toFixed(1)}s, ${newLogs.length} edge execution(s), ` +
      `${violations.length} egress violation(s))`,
  );

  return {
    taskId: task.taskId,
    title: task.title,
    resolved: verification.resolved,
    checkOutput: verification.checkOutput,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
    stdoutTail: tailOf(result.stdout),
    stderrTail: tailOf(result.stderr),
    timedOut: result.timedOut,
    driverOk,
    blocked: verification.blocked ?? null,
    edgeExecutions: runEdgeExecutions,
    egressViolations: violations,
    railUsage: {
      inputTokens: newRailFacts.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0),
      outputTokens: newRailFacts.reduce((sum, fact) => sum + (fact.usage?.outputTokens ?? 0), 0),
      dispatches: newRailFacts.length,
      failures: newRailFacts.filter((fact) => fact.outcome === "provider-failure").length,
    },
  };
}
