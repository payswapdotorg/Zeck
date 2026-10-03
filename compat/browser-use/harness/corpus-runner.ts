/**
 * The PPR-024 corpus runner — drives the REAL pinned Browser Use
 * application process (the exact editable checkout in the sandbox venv,
 * through app/app_runner.py) inside the certified proof environment
 * (credential-scrubbed allowlist environment + egress-deny proxy + the
 * app's own constructor-seam configuration), verifies each task
 * mechanically, and records the per-task facts (edge executions, egress
 * violations, rail usage).
 *
 * THE SCRUBBED RUNTIME (credential removal, ACR-007 §5): the subprocess
 * environment is BUILT FROM AN ALLOWLIST — no provider credential can
 * leak in by construction (the identical discipline PPR-018/019/020/022/
 * 023 established). The only credential-shaped value present is the
 * literal placeholder `zeck-local-adapter` (the OpenAI-compatible
 * clients refuse to build without a non-empty key — the value
 * authenticates nothing: the adapter ignores it and no provider host is
 * reachable from the runtime, whose every non-loopback egress is denied
 * by the proof proxy).
 *
 * THE APP PROCESS'S OWN EGRESS: HTTP_PROXY/HTTPS_PROXY point at the
 * proof deny proxy with NO_PROXY=127.0.0.1,localhost — the httpx/openai
 * transports honor them, so every non-loopback request the pinned
 * runtime could ever issue is refused and recorded.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { EgressViolation } from "../../../src/integrations/compatibility/public";
import type { AdapterRequestLog, AdapterServer } from "../adapter/server";
import {
  CORPUS_API_KEY_PLACEHOLDER,
  CORPUS_MAIN_MODEL,
  writeRunnerTaskFile,
  type CorpusTask,
} from "../corpus/tasks";
import type { EgressProxy } from "./egress-proxy";
import type { RailExecutionFact } from "./compose";

/** The harness root (this file's directory). */
const HARNESS_ROOT = dirname(fileURLToPath(import.meta.url));

/** The application-side runner entry (the pinned runtime's app process). */
export const APP_RUNNER_SCRIPT = join(HARNESS_ROOT, "..", "app", "app_runner.py");

/** The pinned-runtime venv's Python (the exact editable checkout). */
export const APP_PYTHON = "/home/z/ppr-024-venv/bin/python";

/**
 * The provider-credential env-var NAMES the battery records facts for
 * (the harness's reusable list plus Browser Use's own provider/cloud
 * credential names at the pinned revision).
 */
export const PROVIDER_CREDENTIAL_ENV_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "COHERE_API_KEY",
  "XAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "GITHUB_COPILOT_TOKEN",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
  "BROWSER_USE_API_KEY",
  "BROWSERUSE_API_KEY",
  "CEREBRAS_API_KEY",
  "FIREWORKS_API_KEY",
  "NVIDIA_API_KEY",
  "NEBIUS_API_KEY",
  "DEEPINFRA_API_KEY",
  "TOGETHERAI_API_KEY",
  "MCP_API_KEY",
] as const;

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
  readonly substrateUsage: {
    readonly operations: number;
    readonly failures: number;
  };
  /** The honest NOT-RUN cause when the task could not execute. */
  readonly unavailable: {
    readonly outcome: "NOT-RUN";
    readonly cause: string;
    readonly owner: string;
  } | null;
}

export interface CorpusRunnerOptions {
  readonly adapter: AdapterServer;
  readonly proxy: EgressProxy;
  readonly workspaceRoot: string;
  /** Per-run wall-clock timeout (ms). Default 420_000. */
  readonly runTimeoutMs?: number;
  /** Pause between tasks (supply pacing). */
  readonly interTaskDelayMs?: number;
  /** The rail facts accessor (the composed stack's telemetry). */
  readonly railFacts: () => readonly RailExecutionFact[];
  /** The substrate facts accessor (the composed stack's telemetry). */
  readonly substrateFacts: () => readonly {
    readonly executionId: string;
    readonly kind: string;
    readonly outcome: "substrate-success" | "substrate-failure";
    readonly latencyMs: number | null;
  }[];
  /** The fixture page URL (actuation + combined tasks). */
  readonly fixtureUrl: string;
  /** Optional pre-task guard: a throw aborts the run BEFORE the task. */
  readonly preTaskGuard?: () => Promise<void>;
  /** Optional per-task checkpoint hook (fires only after unambiguous completion). */
  readonly onTaskComplete?: (outcome: CorpusTaskOutcome) => void;
}

function tailOf(text: string, maxChars = 2400): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/** Build the scrubbed subprocess environment (allowlist only). */
export function scrubbedBrowserUseEnv(options: {
  readonly proxyUrl: string;
  readonly home: string;
  readonly adapterUrl: string;
}): Record<string, string> {
  return {
    PATH: `${dirname(APP_PYTHON)}:/usr/local/bin:/usr/bin:/bin`,
    HOME: options.home,
    TMPDIR: options.home,
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    TERM: "dumb",
    PYTHONUNBUFFERED: "1",
    // The application's delegated destination + the proof egress control:
    PPR_024_ADAPTER_URL: options.adapterUrl,
    PPR_024_MODEL: CORPUS_MAIN_MODEL,
    PPR_024_API_KEY: CORPUS_API_KEY_PLACEHOLDER,
    HTTP_PROXY: options.proxyUrl,
    HTTPS_PROXY: options.proxyUrl,
    http_proxy: options.proxyUrl,
    https_proxy: options.proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    GIT_TERMINAL_PROMPT: "0",
    DO_NOT_TRACK: "1",
    // The pinned runtime's own documented off switches (non-AI endpoints):
    ANONYMIZED_TELEMETRY: "False",
    BROWSER_USE_CLOUD_SYNC: "False",
    BROWSER_USE_HEADLESS: "true",
    // No DEFAULT_LLM: the Agent is always constructed with its own llm=
    // (never the cloud ChatBrowserUse default — the dormant-seam gate).
  };
}

/** Run one application process to completion, collecting output. */
export function runAppRunner(
  options: {
    readonly proxy: EgressProxy;
    readonly home: string;
    readonly adapterUrl: string;
    readonly taskFile: string;
    readonly runTimeoutMs: number;
  },
  workdir: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const env = {
    ...scrubbedBrowserUseEnv({
      proxyUrl: options.proxy.url,
      home: options.home,
      adapterUrl: options.adapterUrl,
    }),
    PPR_024_TASK_FILE: options.taskFile,
  };
  return new Promise((resolve) => {
    const child = spawn(APP_PYTHON, [APP_RUNNER_SCRIPT], {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.runTimeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 4 * 1024 * 1024) {
        out = out.slice(0, 4 * 1024 * 1024);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
      if (err.length > 2 * 1024 * 1024) {
        err = err.slice(0, 2 * 1024 * 1024);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      err += `\n(spawn error: ${error.message})`;
      resolve({ exitCode: 127, stdout: out, stderr: err, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (timedOut ? 124 : 1), stdout: out, stderr: err, timedOut });
    });
  });
}

/** Whether the pinned runtime venv + runner are runnable. */
export function existsBrowserUseRuntime(): boolean {
  return existsSync(APP_PYTHON) && existsSync(APP_RUNNER_SCRIPT);
}

/**
 * Run the corpus: every task through the pinned application process,
 * mechanically verified, with per-edge execution observations from the
 * adapter's request log (scoped to this run) and the egress violations.
 */
export async function runCorpusTasks(
  options: CorpusRunnerOptions,
  tasks: readonly CorpusTask[],
): Promise<readonly CorpusTaskOutcome[]> {
  if (!existsBrowserUseRuntime()) {
    throw new Error(
      `the pinned Browser Use runtime is absent (${APP_PYTHON} / ${APP_RUNNER_SCRIPT}) — install the pinned checkout per the demo entry's reproducibility instructions`,
    );
  }
  const outcomes: CorpusTaskOutcome[] = [];
  const runLabel = new Date().toISOString();
  mkdirSync(options.workspaceRoot, { recursive: true });
  for (const task of tasks) {
    await options.preTaskGuard?.();
    const workdir = join(options.workspaceRoot, `task-${task.taskId}`);
    const home = join(options.workspaceRoot, `task-${task.taskId}-home`);
    mkdirSync(workdir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const taskFile = join(options.workspaceRoot, `task-${task.taskId}.json`);
    writeRunnerTaskFile(taskFile, task, options.fixtureUrl);
    // Stamp the adapter's ambient context so this task's requests are
    // scoped in the adapter's request log (edge-log correlation).
    options.adapter.setRunContext({ corpusTask: task.taskId, runLabel });
    const adapterLogStart = options.adapter.requests().length;
    const railFactsStart = options.railFacts().length;
    const substrateFactsStart = options.substrateFacts().length;
    const egressStart = options.proxy.violations().length;

    const startedAt = Date.now();
    const result = await runAppRunner(
      {
        proxy: options.proxy,
        home,
        adapterUrl: options.adapter.url,
        taskFile,
        runTimeoutMs: options.runTimeoutMs ?? 420_000,
      },
      workdir,
    );
    const durationMs = Date.now() - startedAt;

    const runEdgeLogs = options.adapter
      .requests()
      .slice(adapterLogStart)
      .filter((log) => log.corpusTask === task.taskId);
    const edgeExecutions = runEdgeLogs.map((log) => ({
      edgeId: log.edgeId,
      executionId: log.executionId,
      replayed: log.replayed,
    }));
    const executionIds = new Set(runEdgeLogs.map((log) => log.executionId));
    const railFacts = options.railFacts().slice(railFactsStart);
    const scopedRail = railFacts.filter((fact) => executionIds.has(fact.executionId));
    const substrateFacts = options.substrateFacts().slice(substrateFactsStart);
    const scopedSubstrate = substrateFacts.filter((fact) => executionIds.has(fact.executionId));

    // Parse the runner's result JSON (the LAST stdout line).
    let parsed: Record<string, unknown> | null = null;
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        parsed = JSON.parse(lines[i] ?? "") as Record<string, unknown>;
        break;
      } catch {
        continue;
      }
    }

    let unavailable: CorpusTaskOutcome["unavailable"] = null;
    if (result.timedOut) {
      unavailable = {
        outcome: "NOT-RUN",
        cause: `the task hit its ${options.runTimeoutMs ?? 420_000}ms wall-clock timeout before completing (a quota-window stall is never recorded as a corpus failure)`,
        owner: "operator-provider boundary (supply pacing/quota)",
      };
    }

    const verification =
      unavailable === null && parsed !== null
        ? task.verify(parsed)
        : unavailable === null
          ? {
              resolved: false,
              checkOutput: `the runner produced no result JSON (exit ${result.exitCode}; stderr tail: ${tailOf(result.stderr, 400)})`,
            }
          : { resolved: false, checkOutput: unavailable.cause };

    const outcome: CorpusTaskOutcome = {
      taskId: task.taskId,
      title: task.title,
      resolved: verification.resolved,
      checkOutput: verification.checkOutput,
      exitCode: result.exitCode,
      durationMs,
      stdoutTail: tailOf(result.stdout),
      stderrTail: tailOf(result.stderr),
      timedOut: result.timedOut,
      edgeExecutions,
      egressViolations: options.proxy.violations().slice(egressStart),
      railUsage: {
        inputTokens: scopedRail.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0),
        outputTokens: scopedRail.reduce((sum, fact) => sum + (fact.usage?.outputTokens ?? 0), 0),
        dispatches: scopedRail.length,
        failures: scopedRail.filter((fact) => fact.outcome === "provider-failure").length,
      },
      substrateUsage: {
        operations: scopedSubstrate.length,
        failures: scopedSubstrate.filter((fact) => fact.outcome === "substrate-failure").length,
      },
      unavailable,
    };
    outcomes.push(outcome);
    options.onTaskComplete?.(outcome);
    if (options.interTaskDelayMs !== undefined && options.interTaskDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.interTaskDelayMs));
    }
  }
  return outcomes;
}

/** The adapter request log's shape re-export (consumers correlate by edge). */
export type { AdapterRequestLog };
