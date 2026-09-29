/**
 * The PPR-019 corpus runner — runs the declared representative IDE-task
 * corpus through the REAL pinned Cline CLI inside the proof
 * environment (egress-deny preload + credential-scrubbed env +
 * isolated config seeded with the openai-compatible provider pointed at
 * the local Zeck adapter), verifies each task mechanically, and records
 * the per-task facts (edge executions, egress violations, rail usage).
 */

import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EgressViolation } from "../../../src/integrations/compatibility/public";
import type { AdapterRequestLog, AdapterServer } from "../adapter/server";
import { runCline, type ClineRunResult } from "./runtime-spawn";
import type { ClineRuntimeConfig } from "./cline-config";
import { CORPUS_MODEL_ID, type CorpusTask } from "../corpus/tasks";
import type { RailExecutionFact } from "./compose";

export interface CorpusRunnerOptions {
  readonly clineRoot: string;
  readonly workRoot: string;
  readonly adapter: AdapterServer;
  /** The adapter base URL (http://127.0.0.1:<port>/v1). */
  readonly adapterBaseUrl: string;
  /** Provider-settings overrides per task come from the task itself. */
  readonly railFacts: () => readonly RailExecutionFact[];
  /** Per-run wall-clock timeout (ms). Default 420_000. */
  readonly runTimeoutMs?: number;
  /** Provider id + model override for the CLI flags. */
  readonly providerId?: string;
  readonly modelId?: string;
  /** Extra env for the child (the baseline arm passes its provider env). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

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
  readonly edgeExecutions: readonly { readonly edgeId: string; readonly executionId: string; readonly replayed: boolean }[];
  readonly egressViolations: readonly EgressViolation[];
  readonly railUsage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly dispatches: number;
    readonly failures: number;
  };
}

function tailOf(text: string, maxChars = 1200): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/** Read one run's egress violations (the preload's JSONL log). */
export function readEgressLog(path: string): readonly EgressViolation[] {
  if (!existsSync(path)) {
    return [];
  }
  const violations: EgressViolation[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      violations.push(JSON.parse(trimmed) as EgressViolation);
    } catch {
      // A malformed line is skipped (the observation counts parseable facts).
    }
  }
  return violations;
}

/** Run the whole corpus (or a task subset) and return per-task outcomes. */
export async function runCorpus(
  options: CorpusRunnerOptions,
  tasks: readonly CorpusTask[],
): Promise<readonly CorpusTaskOutcome[]> {
  const outcomes: CorpusTaskOutcome[] = [];
  for (const task of tasks) {
    const outcome = await runOneTask(options, task);
    outcomes.push(outcome);
    console.log(
      `[ppr-019 corpus] ${task.taskId}: ${outcome.resolved ? "RESOLVED" : "UNRESOLVED"} (${(outcome.durationMs / 1000).toFixed(1)}s, ${outcome.edgeExecutions.length} edge execution(s))`,
    );
  }
  return outcomes;
}

async function runOneTask(
  options: CorpusRunnerOptions,
  task: CorpusTask,
): Promise<CorpusTaskOutcome> {
  const workdir = join(options.workRoot, task.taskId);
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  const configDir = join(options.workRoot, `${task.taskId}-config`);
  const dataDir = join(options.workRoot, `${task.taskId}-data`);
  rmSync(configDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  const egressLogPath = join(options.workRoot, `${task.taskId}.egress.jsonl`);

  const config: ClineRuntimeConfig = {
    configDir,
    dataDir,
    adapterBaseUrl: options.adapterBaseUrl,
    modelId: options.modelId ?? CORPUS_MODEL_ID,
    ...(task.settings?.contextWindow === undefined
      ? {}
      : { contextWindow: task.settings.contextWindow }),
  };

  task.fixture(workdir);

  const providerId = options.providerId ?? "openai-compatible";
  const args = [
    "--config",
    configDir,
    "--data-dir",
    dataDir,
    "-P",
    providerId,
    "-m",
    config.modelId,
    ...task.args,
  ];

  const railFactsBefore = new Set(options.railFacts().map((fact) => fact.attemptId));
  const adapterBefore = options.adapter.requests().length;
  options.adapter.setRunContext({ corpusTask: task.taskId, runLabel: task.taskId });

  const result: ClineRunResult = await runCline({
    clineRoot: options.clineRoot,
    config,
    args,
    cwd: workdir,
    timeoutMs: options.runTimeoutMs ?? 420_000,
    egressLogPath,
    extraEnv: options.extraEnv,
  });
  options.adapter.setRunContext(null);

  const verification = task.verify({
    workdir,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });

  const newLogs: readonly AdapterRequestLog[] = options.adapter.requests().slice(adapterBefore);
  const newRailFacts = options.railFacts().filter((fact) => !railFactsBefore.has(fact.attemptId));

  return {
    taskId: task.taskId,
    title: task.title,
    resolved: verification.resolved,
    checkOutput: verification.checkOutput,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutTail: tailOf(result.stdout),
    stderrTail: tailOf(result.stderr),
    timedOut: result.timedOut,
    edgeExecutions: newLogs.map((log) => ({
      edgeId: log.edgeId,
      executionId: log.executionId,
      replayed: log.replayed,
    })),
    egressViolations: readEgressLog(egressLogPath),
    railUsage: {
      inputTokens: newRailFacts.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0),
      outputTokens: newRailFacts.reduce((sum, fact) => sum + (fact.usage?.outputTokens ?? 0), 0),
      dispatches: newRailFacts.length,
      failures: newRailFacts.filter((fact) => fact.outcome === "provider-failure").length,
    },
  };
}
