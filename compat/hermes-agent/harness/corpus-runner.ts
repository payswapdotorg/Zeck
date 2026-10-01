/**
 * The PPR-022 corpus runner — drives the REAL pinned Hermes-Agent runtime
 * (hermes-agent at the exact upstream git revision, installed editable in
 * a dedicated Python 3.14.7 venv) through the Zeck adapter inside the
 * proof environment (egress-deny proxy + credential-scrubbed allowlist
 * environment + the app's own configuration surface pointed at the
 * adapter), verifies each task mechanically, and records the per-task
 * facts (edge executions, egress violations, rail usage).
 *
 * THE SCRUBBED RUNTIME (credential removal, ACR-007 §5): the subprocess
 * environment is BUILT FROM AN ALLOWLIST — no provider credential can
 * leak in by construction (the same discipline PPR-018/019/020
 * established). The only credential-shaped values present are the
 * literal placeholder `zeck-local-adapter` (the openai SDK refuses to
 * build a client without a non-empty key — the value authenticates
 * nothing: the adapter ignores it and no provider host is reachable from
 * the runtime, whose every non-loopback egress is denied by the proof
 * proxy) and the image-gen key_env placeholder of the same value.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EgressViolation } from "../../../src/integrations/compatibility/public";
import type { AdapterRequestLog, AdapterServer } from "../adapter/server";
import { CORPUS_API_KEY_PLACEHOLDER, CORPUS_IMAGE_KEY_ENV, type CorpusTask } from "../corpus/tasks";
import type { EgressProxy } from "./egress-proxy";
import type { RailExecutionFact } from "./compose";

/** Where the pinned Hermes venv lives (installed from the exact revision). */
export const HERMES_VENV_DIR = "/home/z/my-project/.venv-hermes" as const;

/** The provider-credential env-var NAMES the battery records facts for
 * (the application's own credential surface at the pinned revision —
 * the harness's reusable list plus Hermes's own names). */
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
  "GITHUB_TOKEN",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
  "NOUS_API_KEY",
  "GLM_API_KEY",
  "KIMI_CODING_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "NVIDIA_API_KEY",
  "XIAOMI_API_KEY",
  "ARCEEAI_API_KEY",
  "OLLAMA_API_KEY",
  "DEEPINFRA_API_KEY",
  "KILOCODE_API_KEY",
  "AI_GATEWAY_API_KEY",
  "LM_API_KEY",
  "FAL_KEY",
  "EXA_API_KEY",
  "FIRECRAWL_API_KEY",
  "ELEVENLABS_API_KEY",
  "VOICE_TOOLS_OPENAI_KEY",
  "MANAGED_TOOL_GATEWAY_TOKEN",
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
}

export interface CorpusRunnerOptions {
  readonly adapter: AdapterServer;
  readonly proxy: EgressProxy;
  readonly workspaceRoot: string;
  readonly venvPath?: string;
  /** Per-run wall-clock timeout (ms). Default 420_000. */
  readonly runTimeoutMs?: number;
  /** Pause between tasks (supply pacing). */
  readonly interTaskDelayMs?: number;
  /** The rail facts accessor (the composed stack's telemetry). */
  readonly railFacts: () => readonly RailExecutionFact[];
  /** Optional pre-task guard: a throw aborts the run BEFORE the task (never checkpoints a poisoned outcome). */
  readonly preTaskGuard?: () => Promise<void>;
  /** Optional per-task checkpoint hook: fires ONLY after a task ran to an
   * unambiguous completion (the caller decides what to persist; timed-out
   * runs are surfaced so the caller can decline to checkpoint them — a
   * quota-window stall must never be recorded as a corpus failure). */
  readonly onTaskComplete?: (outcome: CorpusTaskOutcome) => void;
}

function tailOf(text: string, maxChars = 1600): string {
  return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
}

/**
 * Write the certified runtime's HERMES_HOME config.yaml — the app's OWN
 * configuration surface (every axis is a documented Hermes config key;
 * zero code changes): the custom provider endpoint, every auxiliary task
 * pinned to the main (delegated) chain, and the specialized media tools
 * selected onto their OpenAI-compatible backends pointed at the adapter.
 */
export function writeHermesConfig(
  home: string,
  adapterUrl: string,
  task: CorpusTask,
): void {
  const config = [
    "# PPR-022 certified corpus configuration — the pinned app's own config surface.",
    "agent:",
    `  max_turns: ${task.spec.maxTurns ?? 40}`,
    "model:",
    `  default: "glm-4-plus"`,
    "  provider: \"custom\"",
    `  base_url: "${adapterUrl}"`,
    "  streaming: true",
    `  context_length: ${task.spec.contextLength ?? 131_072}`,
    "",
    "# Every auxiliary task pinned to the MAIN (delegated custom) chain —",
    "# no OpenRouter/Nous/Anthropic rung can ever fire for a certified run.",
    "auxiliary:",
    "  vision:",
    "    provider: main",
    "  web_extract:",
    "    provider: main",
    "  title_generation:",
    "    enabled: true",
    "    provider: main",
    "  session_search:",
    "    provider: main",
    "  compression:",
    "    provider: main",
    "  background_review:",
    "    enabled: false",
    "    provider: main",
    "",
    "compression:",
    `  threshold: ${task.spec.compressionThreshold ?? 0.9}`,
    // The documented absolute-cap axis: compression fires at the LOWER of
    // the ratio threshold and this token count. The pinned runtime's
    // ratio math floors every window's trigger at ~85% of the effective
    // input budget (MINIMUM_CONTEXT_LENGTH = 64,000) — unreachable
    // mid-task — so the corpus pins the absolute cap (live-verified axis
    // from cli-config.yaml.example: "compression.threshold_tokens").
    `  threshold_tokens: ${task.spec.compressionTokenCap ?? 200_000}`,
    "",
    "# The specialized media tools onto their OpenAI-compatible backends.",
    "# The supply's voice catalog is its own (tongtong) — the documented",
    "# tts.openai.voice axis pins it (the runtime's OpenAI default 'alloy' is",
    "# not a voice this supply serves; live-verified HTTP 400 otherwise).",
    "tts:",
    "  provider: openai",
    "  openai:",
    `    api_key: "${CORPUS_API_KEY_PLACEHOLDER}"`,
    `    base_url: "${adapterUrl}"`,
    "    voice: \"tongtong\"",
    "# The STT surface shares the same OpenAI-compatible resolution:",
    "# stt.openai.{api_key,base_url} (live-verified: without this sub-block",
    "# the pinned runtime refuses to construct an STT client at all).",
    "stt:",
    "  provider: openai",
    "  openai:",
    `    api_key: "${CORPUS_API_KEY_PLACEHOLDER}"`,
    `    base_url: "${adapterUrl}"`,
    "image_gen:",
    "  provider: openai",
    "  openai:",
    `    base_url: "${adapterUrl}"`,
    `    key_env: "${CORPUS_IMAGE_KEY_ENV}"`,
    "",
  ].join("\n");
  writeFileSync(join(home, "config.yaml"), config);
}

/** Build the scrubbed subprocess environment (allowlist only). */
export function scrubbedHermesEnv(options: {
  readonly proxyUrl: string;
  readonly home: string;
  readonly venvPath: string;
}): Record<string, string> {
  const venvBin = join(options.venvPath, "bin");
  return {
    PATH: `${venvBin}:/usr/local/bin:/usr/bin:/bin`,
    HOME: options.home,
    HERMES_HOME: options.home,
    HTTP_PROXY: options.proxyUrl,
    HTTPS_PROXY: options.proxyUrl,
    http_proxy: options.proxyUrl,
    https_proxy: options.proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    PYTHONUNBUFFERED: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C.UTF-8",
    LANG: "C.UTF-8",
    TERM: "dumb",
    // The image-gen openai plugin's key_env axis — the literal PLACEHOLDER
    // (never a credential; the adapter ignores the Authorization header).
    [CORPUS_IMAGE_KEY_ENV]: CORPUS_API_KEY_PLACEHOLDER,
    // Keep the pinned runtime's startup quiet and offline:
    // no update checks, no telemetry, no skills-hub fetches.
    HERMES_DISABLE_UPDATE_CHECK: "1",
    HERMES_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
  };
}

/** The minimal options the spawn needs (shared by the battery's arms). */
export interface DriverRunOptions {
  readonly venvPath?: string;
  readonly proxy: EgressProxy;
  readonly runTimeoutMs?: number;
  /** Extra env entries (the direct-baseline arm overrides NO_PROXY; never credential material). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * Run one chat one-shot (`hermes -z`) to completion, collecting output.
 *
 * The turn limit is NOT a CLI flag: the pinned runtime's CLI has no
 * --max-turns option (its surface is -z/-m/--provider/--reasoning/-t/…),
 * and `agent.max_turns` in the config.yaml that writeHermesConfig
 * writes is the runtime's own documented axis for it.
 */
export function runOneShot(
  options: DriverRunOptions,
  workdir: string,
  home: string,
  instruction: string,
  toolsets: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const venvPath = options.venvPath ?? HERMES_VENV_DIR;
  const baseEnv = scrubbedHermesEnv({
    proxyUrl: options.proxy.url,
    home,
    venvPath,
  });
  const env = { ...baseEnv, ...(options.extraEnv ?? {}) };
  const args = ["-z", instruction];
  if (toolsets.length > 0) {
    args.push("-t", toolsets);
  }
  return new Promise((resolve) => {
    const child = spawn(join(venvPath, "bin", "hermes"), args, {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 8 * 1024 * 1024) {
        out = out.slice(0, 8 * 1024 * 1024);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
      if (err.length > 4 * 1024 * 1024) {
        err = err.slice(0, 4 * 1024 * 1024);
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

/** Run the pinned media-surface driver (the STT surface) to completion. */
export function runMediaDriver(
  options: DriverRunOptions,
  workdir: string,
  home: string,
  audioPath: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  const venvPath = options.venvPath ?? HERMES_VENV_DIR;
  const baseEnv = scrubbedHermesEnv({
    proxyUrl: options.proxy.url,
    home,
    venvPath,
  });
  const env = { ...baseEnv, ...(options.extraEnv ?? {}) };
  const driver = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "corpus",
    "hermes_media.py",
  );
  return new Promise((resolve) => {
    const child = spawn(join(venvPath, "bin", "python"), [driver, "transcribe", audioPath], {
      cwd: workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
      if (err.length > 2 * 1024 * 1024) {
        err = err.slice(0, 2 * 1024 * 1024);
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.runTimeoutMs ?? 240_000);
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
    if (options.preTaskGuard !== undefined) {
      await options.preTaskGuard();
    }
    if (index > 0 && (options.interTaskDelayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.interTaskDelayMs));
    }
    const outcome = await runOneTask(options, task);
    outcomes.push(outcome);
    options.onTaskComplete?.(outcome);
  }
  return outcomes;
}

async function runOneTask(
  options: CorpusRunnerOptions,
  task: CorpusTask,
): Promise<CorpusTaskOutcome> {
  const startedAt = Date.now();
  const workdir = join(options.workspaceRoot, task.taskId);
  const home = join(options.workspaceRoot, `${task.taskId}-home`);
  rmSync(workdir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  mkdirSync(workdir, { recursive: true });
  mkdirSync(home, { recursive: true });
  task.fixture(workdir);
  writeHermesConfig(home, options.adapter.url, task);

  const violationsBefore = options.proxy.violations().length;
  const railBefore = new Set(options.railFacts().map((fact) => fact.attemptId));
  const adapterBefore = options.adapter.requests().length;
  options.adapter.setRunContext({ corpusTask: task.taskId, runLabel: task.taskId });

  const result =
    task.taskId === "transcribe-memo"
      ? await runMediaDriver(
          {
            proxy: options.proxy,
            venvPath: options.venvPath,
            runTimeoutMs: options.runTimeoutMs,
          },
          workdir,
          home,
          join(workdir, "voice-memo.wav"),
        )
      : await runOneShot(
          {
            proxy: options.proxy,
            venvPath: options.venvPath,
            runTimeoutMs: options.runTimeoutMs,
          },
          workdir,
          home,
          task.spec.instruction,
          task.spec.toolsets,
        );
  options.adapter.setRunContext(null);

  const verification = task.verify({
    workdir,
    home,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });

  const newLogs: readonly AdapterRequestLog[] = options.adapter.requests().slice(adapterBefore);
  const newRailFacts = options.railFacts().filter((fact) => !railBefore.has(fact.attemptId));
  const violations = options.proxy.violations().slice(violationsBefore);

  console.log(
    `[ppr-022 corpus] ${task.taskId}: ${verification.resolved ? "RESOLVED" : "UNRESOLVED"} ` +
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

/** The pinned venv sanity check (the honest NOT-RUN gate for absent environments). */
export function hermesVenvPresent(venvPath = HERMES_VENV_DIR): boolean {
  return existsSync(join(venvPath, "bin", "hermes")) && existsSync(join(venvPath, "bin", "python"));
}
