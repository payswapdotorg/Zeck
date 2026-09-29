/**
 * The PPR-020 corpus runner — drives the REAL pinned OpenHands agent SDK
 * (openhands-sdk 1.49.6 / openhands-tools 1.49.6, installed editable from
 * the exact upstream git revision) through the Zeck adapter inside the
 * proof environment (egress-deny proxy + credential-scrubbed allowlist
 * environment + the SDK's own configuration surface pointed at the
 * adapter), verifies each task mechanically, and records the per-task
 * facts (edge executions, egress violations, rail usage).
 *
 * THE SCRUBBED RUNTIME (credential removal, battery step 2): the
 * subprocess environment is BUILT FROM AN ALLOWLIST — no provider
 * credential can leak in by construction (the same discipline PPR-018
 * established). The only provider-shaped value present is the LLM
 * api_key carrying the literal placeholder `zeck-local-adapter` (the
 * litellm client refuses to build an `openai/`-prefixed request without
 * a non-empty key — the value authenticates nothing: the adapter
 * ignores it and no provider host is reachable from the runtime, whose
 * every non-loopback egress is denied by the proof proxy).
 */

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EgressViolation } from "../../../src/integrations/compatibility/public";
import type { AdapterRequestLog, AdapterServer } from "../adapter/server";
import {
  CORPUS_API_KEY_PLACEHOLDER,
  CORPUS_MODEL_ID,
  type CorpusTask,
} from "../corpus/tasks";
import type { EgressProxy } from "./egress-proxy";
import type { RailExecutionFact } from "./compose";

/** Where the pinned OpenHands venv lives (installed from the exact tag). */
export const OPENHANDS_VENV = "/home/z/my-project/.venv-openhands" as const;

/** The placeholder litellm requires (disclosed — never a credential). */
export const OPENAI_KEY_PLACEHOLDER = CORPUS_API_KEY_PLACEHOLDER;

/** The provider-credential env-var NAMES the battery records facts for. */
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
  "LMNR_PROJECT_API_KEY",
  "GRAYSWAN_API_KEY",
  "CODEX_API_KEY",
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
  readonly driverOk: boolean;
  readonly finalMessage: string;
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
  readonly venvPath?: string;
  /** Override for tests (defaults to the pinned venv's python). */
  readonly pythonBinary?: string;
  /** Override for tests (defaults to the pinned driver in the corpus dir). */
  readonly driverScript?: string;
  /** Per-run wall-clock timeout (ms). Default 420_000. */
  readonly runTimeoutMs?: number;
  /** Pause between tasks (supply pacing). */
  readonly interTaskDelayMs?: number;
  /** The rail facts accessor (the composed stack's telemetry). */
  readonly railFacts: () => readonly RailExecutionFact[];
}

function tailOf(text: string, maxChars = 1600): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/** Build the scrubbed subprocess environment (allowlist only). */
export function scrubbedOpenHandsEnv(options: {
  readonly adapterUrl: string;
  readonly proxyUrl: string;
  readonly home: string;
  readonly venvPath: string;
}): Record<string, string> {
  const venvBin = join(options.venvPath, "bin");
  return {
    PATH: `${venvBin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: options.home,
    HTTP_PROXY: options.proxyUrl,
    HTTPS_PROXY: options.proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    PYTHONUNBUFFERED: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    // Use LiteLLM's bundled local cost map — no metadata fetch (the
    // proof egress environment is default-deny; this keeps the runtime
    // from even attempting the fetch).
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    // Suppress the SDK's banner (cosmetic; keeps stdout parseable).
    OPENHANDS_SUPPRESS_BANNER: "1",
  };
}

/** The minimal options the pinned-driver spawn needs (shared by the battery's arms). */
export interface DriverRunOptions {
  readonly venvPath?: string;
  readonly pythonBinary?: string;
  readonly driverScript?: string;
  readonly proxy: EgressProxy;
  readonly runTimeoutMs?: number;
  /** Extra env entries (the direct-baseline arm overrides NO_PROXY; never credential material). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/** Run the pinned driver to completion, collecting output. */
export function runDriver(
  options: DriverRunOptions,
  workdir: string,
  specFile: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const python =
    options.pythonBinary ?? join(options.venvPath ?? OPENHANDS_VENV, "bin", "python");
  const driver =
    options.driverScript ??
    join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "corpus",
      "openhands_task.py",
    );
  const baseEnv = scrubbedOpenHandsEnv({
    adapterUrl: "",
    proxyUrl: options.proxy.url,
    home: workdir,
    venvPath: options.venvPath ?? OPENHANDS_VENV,
  });
  const env = { ...baseEnv, ...(options.extraEnv ?? {}) };
  return new Promise((resolve) => {
    const child = spawn(python, [driver, specFile], {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 20 * 1024 * 1024) {
        out = out.slice(0, 20 * 1024 * 1024);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
      if (err.length > 5 * 1024 * 1024) {
        err = err.slice(0, 5 * 1024 * 1024);
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.runTimeoutMs ?? 420_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout: out, stderr: err, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      err += String(error);
      resolve({ exitCode: -1, stdout: out, stderr: err, timedOut });
    });
  });
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

  // The driver task spec (the pinned runtime's own configuration axes).
  const spec = {
    task_id: task.taskId,
    workspace: workdir,
    home: workdir,
    instruction: task.spec.instruction,
    ...(task.spec.followups === undefined ? {} : { followups: task.spec.followups }),
    tools: task.spec.tools,
    terminal_type: "subprocess",
    max_iterations: task.spec.maxIterations ?? 40,
    ...(task.spec.condenser === undefined
      ? {}
      : {
          condenser: {
            max_size: task.spec.condenser.maxSize,
            keep_first: task.spec.condenser.keepFirst,
          },
        }),
    ...(task.spec.seedOracleProfile === true
      ? { seed_oracle_profile: true }
      : {}),
    ...(task.spec.image === undefined ? {} : { image: join(workdir, task.spec.image) }),
    llm: {
      model: CORPUS_MODEL_ID,
      base_url: options.adapter.url,
      api_key: CORPUS_API_KEY_PLACEHOLDER,
      vision: task.spec.image !== undefined,
    },
  };
  const specFile = join(options.workspaceRoot, `${task.taskId}.spec.json`);
  writeFileSync(specFile, JSON.stringify(spec, null, 2));

  const violationsBefore = options.proxy.violations().length;
  const railBefore = new Set(options.railFacts().map((fact) => fact.attemptId));
  const adapterBefore = options.adapter.requests().length;
  options.adapter.setRunContext({ corpusTask: task.taskId, runLabel: task.taskId });

  const result = await runDriver(
    {
      proxy: options.proxy,
      venvPath: options.venvPath,
      pythonBinary: options.pythonBinary,
      driverScript: options.driverScript,
      runTimeoutMs: options.runTimeoutMs,
    },
    workdir,
    specFile,
  );
  options.adapter.setRunContext(null);

  const verification = task.verify({
    workdir,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });

  const newLogs: readonly AdapterRequestLog[] = options.adapter.requests().slice(adapterBefore);
  const newRailFacts = options.railFacts().filter((fact) => !railBefore.has(fact.attemptId));
  const violations = options.proxy.violations().slice(violationsBefore);

  // The driver's machine-readable result (ok + final message).
  const resultLine = result.stdout
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("OPENHANDS_RESULT:"));
  let driverOk = false;
  let finalMessage = "";
  if (resultLine !== undefined) {
    try {
      const parsed = JSON.parse(resultLine.slice("OPENHANDS_RESULT:".length)) as {
        readonly ok?: unknown;
        readonly final_message?: unknown;
      };
      driverOk = parsed.ok === true;
      finalMessage = typeof parsed.final_message === "string" ? parsed.final_message : "";
    } catch {
      driverOk = false;
    }
  }

  console.log(
    `[ppr-020 corpus] ${task.taskId}: ${verification.resolved ? "RESOLVED" : "UNRESOLVED"} ` +
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
    finalMessage,
    edgeExecutions: newLogs.map((log) => ({
      edgeId: log.edgeId,
      executionId: log.executionId,
      replayed: log.replayed,
    })),
    egressViolations: violations,
    railUsage: {
      inputTokens: newRailFacts.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0),
      outputTokens: newRailFacts.reduce((sum, fact) => sum + (fact.usage?.outputTokens ?? 0), 0),
      dispatches: newRailFacts.length,
      failures: newRailFacts.filter((fact) => fact.outcome === "provider-failure").length,
    },
  };
}
