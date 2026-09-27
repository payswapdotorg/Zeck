/**
 * The PPR-018 corpus runner — materializes each corpus task as a fresh
 * git repository, drives the REAL pinned Aider binary (from the
 * dedicated venv, 100% unmodified at revision 5dc9490bb…) through the
 * Zeck adapter under a scrubbed environment and the egress-deny proxy,
 * then verifies each task mechanically.
 *
 * THE SCRUBBED RUNTIME (credential removal, battery step 2): the
 * subprocess environment is BUILT FROM AN ALLOWLIST — no provider
 * credential can leak in by construction. The single provider-shaped
 * variable present is OPENAI_API_KEY carrying the literal placeholder
 * `zeck-local-adapter` (LiteLLM's client refuses to build an
 * openai/-prefixed request without a non-empty key — the value
 * authenticates nothing: the adapter ignores it and no provider host is
 * reachable from the runtime).
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODING_CORPUS, type CorpusTask } from "../corpus/tasks";
import { MODEL_MAIN } from "../adapter/edges";
import type { AdapterServer } from "../adapter/server";
import type { EgressProxy } from "./egress-proxy";

/** Where the pinned Aider venv lives (installed from the exact commit). */
export const AIDER_VENV = "/home/z/my-project/.venv-aider" as const;

/** The placeholder LiteLLM requires (disclosed — never a credential). */
export const OPENAI_KEY_PLACEHOLDER = "zeck-local-adapter" as const;

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
  "GITHUB_COPILOT_TOKEN",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
] as const;

/** Aider's own model-settings surface (the customization test artifact). */
export const AIDER_MODEL_SETTINGS = `# PPR-018 corpus configuration — Aider's own model-settings surface
# (docs: .aider.model.settings.yml). This file configures the delegated
# models through Aider's public customization surface: no Aider code is
# modified.
- name: ${MODEL_MAIN}
  edit_format: diff
  use_repo_map: false
  weak_model_name: openai/zeck-weak
- name: openai/zeck-weak
  edit_format: whole
  use_repo_map: false
`;

/** One corpus task's run outcome (the battery's runtime evidence). */
export interface CorpusRunOutcome {
  readonly taskId: string;
  readonly resolved: boolean;
  readonly checkOutput: string;
  readonly turns: number;
  readonly aiderExitCode: number | null;
  readonly aiderTail: string;
  readonly commitCount: number;
  readonly durationMs: number;
  readonly workdir: string;
  /** Aider's own token accounting parsed from its report lines (sent/received). */
  readonly aiderReportedTokens: { sent: number; received: number };
}

export interface CorpusRunnerOptions {
  readonly adapter: AdapterServer;
  readonly proxy: EgressProxy;
  readonly workspaceRoot: string;
  readonly venvPath?: string;
  /** Override for tests (defaults to the pinned venv's aider). */
  readonly aiderBinary?: string;
  /** Pause between tasks (supply pacing; the proof's model supply throttles bursts). */
  readonly interTaskDelayMs?: number;
}

/** Build the scrubbed subprocess environment (allowlist only). */
export function scrubbedAiderEnv(options: {
  readonly adapterUrl: string;
  readonly proxyUrl: string;
  readonly home: string;
}): Record<string, string> {
  return {
    PATH: `${AIDER_VENV}/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: options.home,
    OPENAI_API_BASE: options.adapterUrl,
    OPENAI_API_KEY: OPENAI_KEY_PLACEHOLDER,
    HTTP_PROXY: options.proxyUrl,
    HTTPS_PROXY: options.proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    PYTHONUNBUFFERED: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C.UTF-8",
    // Use LiteLLM's bundled local cost map — no metadata fetch (the
    // proof egress environment is default-deny; this keeps the runtime
    // from even attempting the fetch).
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
  };
}

function minimalGitEnv(home: string): Record<string, string> {
  return {
    PATH: `${AIDER_VENV}/bin:/usr/bin:/bin`,
    HOME: home,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C.UTF-8",
  };
}

/** Run one process to completion (stdin script optional), collecting output. */
export async function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  stdin: string,
  timeoutMs = 300_000,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.stdin?.write(stdin);
    child.stdin?.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout: out, stderr: err });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      err += String(error);
      resolve({ exitCode: null, stdout: out, stderr: err });
    });
  });
}

/** Materialize one task's fresh repo and return its path. */
export function materializeTask(task: CorpusTask, root: string): string {
  const workdir = join(root, task.id);
  mkdirSync(workdir, { recursive: true });
  for (const [path, content] of Object.entries(task.files)) {
    writeFileSync(join(workdir, path), content);
  }
  writeFileSync(join(workdir, ".aider.model.settings.yml"), AIDER_MODEL_SETTINGS);
  writeFileSync(join(workdir, ".aider.chat.history.md"), "");
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", workdir, ...args], { env: minimalGitEnv(workdir) });
  git("init", "-q");
  git("config", "user.name", "Corpus Runner");
  git("config", "user.email", "ppr-018-corpus@zeck-proof.invalid");
  git("add", "-A");
  git("commit", "-q", "-m", `corpus baseline: ${task.id}`);
  return workdir;
}

/** The Aider CLI flags of the declared corpus configuration. */
export function aiderCorpusArgs(adapterUrl: string, chatFiles: readonly string[]): string[] {
  return [
    "--model",
    MODEL_MAIN,
    "--openai-api-base",
    adapterUrl,
    "--edit-format",
    "diff",
    "--no-stream",
    "--yes-always",
    "--no-analytics",
    "--no-check-update",
    "--no-show-model-warnings",
    "--no-auto-lint",
    "--no-auto-test",
    "--no-fancy-input",
    "--no-pretty",
    "--no-suggest-shell-commands",
    ...chatFiles.flatMap((file) => ["--file", file]),
  ];
}

/** Run one corpus task end-to-end through real pinned Aider. */
export async function runCorpusTask(
  task: CorpusTask,
  options: CorpusRunnerOptions,
): Promise<CorpusRunOutcome> {
  const startedAt = Date.now();
  const workdir = materializeTask(task, options.workspaceRoot);
  const env = scrubbedAiderEnv({
    adapterUrl: options.adapter.url,
    proxyUrl: options.proxy.url,
    home: workdir,
  });
  options.adapter.setRunContext({ corpusTask: task.id, runLabel: task.id });

  const aiderBinary =
    options.aiderBinary ?? join(options.venvPath ?? AIDER_VENV, "bin", "aider");
  const aider = await runProcess(
    aiderBinary,
    aiderCorpusArgs(options.adapter.url, task.chatFiles),
    workdir,
    env,
    `${task.turns.join("\n")}\n`,
  );
  options.adapter.setRunContext(null);

  // The mechanical verification: the task's own check script.
  const check = await runProcess(
    join(options.venvPath ?? AIDER_VENV, "bin", "python"),
    ["check.py"],
    workdir,
    {
      PATH: `${AIDER_VENV}/bin:/usr/bin:/bin`,
      HOME: workdir,
      PYTHONUNBUFFERED: "1",
      LC_ALL: "C.UTF-8",
    },
    "",
    60_000,
  );

  const log = spawnSync("git", ["-C", workdir, "log", "--oneline"], {
    env: minimalGitEnv(workdir),
  });
  const commitCount = String(log.stdout ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0).length;

  return {
    taskId: task.id,
    resolved: check.exitCode === 0,
    aiderReportedTokens: parseAiderTokens(`${aider.stdout}\n${aider.stderr}`),
    checkOutput: `${check.stdout}${check.stderr}`.trim(),
    turns: task.turns.length,
    aiderExitCode: aider.exitCode,
    aiderTail: aider.stdout.split("\n").slice(-30).join("\n"),
    commitCount,
    durationMs: Date.now() - startedAt,
    workdir,
  };
}

/** Run the whole corpus (sequential — one Aider session per task). */
export async function runCorpus(
  options: CorpusRunnerOptions,
  tasks: readonly CorpusTask[] = CODING_CORPUS,
): Promise<readonly CorpusRunOutcome[]> {
  const outcomes: CorpusRunOutcome[] = [];
  for (const [index, task] of tasks.entries()) {
    if (index > 0 && (options.interTaskDelayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.interTaskDelayMs));
    }
    outcomes.push(await runCorpusTask(task, options));
  }
  return outcomes;
}

/** Parse aider's per-response token reports ("Tokens: 2.1k sent, 370 received."). */
export function parseAiderTokens(output: string): { sent: number; received: number } {
  let sent = 0;
  let received = 0;
  const pattern = /Tokens:\s*([\d.,]+)\s*([km]?)\s*sent,\s*([\d.,]+)\s*([km]?)\s*received/g;
  let match = pattern.exec(output);
  while (match !== null) {
    const scaleOf = (unit: string) => (unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1);
    sent += Number.parseFloat(match[1]?.replace(/,/g, "") ?? "0") * scaleOf(match[2] ?? "");
    received += Number.parseFloat(match[3]?.replace(/,/g, "") ?? "0") * scaleOf(match[4] ?? "");
    match = pattern.exec(output);
  }
  return { sent: Math.round(sent), received: Math.round(received) };
}
