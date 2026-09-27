/**
 * The PPR-018 DIRECT BASELINE arm (non-Zeck): the same pinned Aider, the
 * same corpus, calling the same GLM supply endpoint DIRECTLY — the
 * application holds the endpoint credential (in LiteLLM extra_headers,
 * written at runtime from the machine supply config, never committed)
 * and no Zeck mediation exists.
 *
 * This arm exists ONLY for the cost/latency-per-resolved-outcome
 * comparison of battery step 7. It is NOT the proof arm: the proof arm
 * (corpus-runner.ts) runs under the scrubbed environment, the egress
 * deny proxy and the Zeck adapter.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CorpusTask } from "../corpus/tasks";
import { AIDER_VENV, aiderCorpusArgs, runProcess, type CorpusRunOutcome } from "./corpus-runner";

export interface BaselineTaskOptions {
  readonly workspaceRoot: string;
  /** The supply endpoint base (e.g. https://internal-api.z.ai/v1). */
  readonly apiBase: string;
  readonly model: string;
  readonly settingsYaml: string;
  readonly envExtra?: Record<string, string>;
}

/** Run one corpus task through pinned Aider DIRECTLY (no Zeck). */
export async function runCorpusTaskWithSettings(
  task: CorpusTask,
  options: BaselineTaskOptions,
): Promise<CorpusRunOutcome> {
  const startedAt = Date.now();
  const workdir = join(options.workspaceRoot, task.id);
  mkdirSync(workdir, { recursive: true });
  for (const [path, content] of Object.entries(task.files)) {
    writeFileSync(join(workdir, path), content);
  }
  writeFileSync(join(workdir, ".aider.model.settings.yml"), options.settingsYaml);
  writeFileSync(join(workdir, ".aider.chat.history.md"), "");
  const gitEnv = {
    PATH: `${AIDER_VENV}/bin:/usr/bin:/bin`,
    HOME: workdir,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C.UTF-8",
  };
  const git = (...args: string[]) => spawnSync("git", ["-C", workdir, ...args], { env: gitEnv });
  git("init", "-q");
  git("config", "user.name", "Corpus Runner");
  git("config", "user.email", "ppr-018-corpus@zeck-proof.invalid");
  git("add", "-A");
  git("commit", "-q", "-m", `corpus baseline: ${task.id}`);

  // The BASELINE env: no proxy (direct egress is the point of the arm),
  // the supply credential in the model settings + placeholder key shape.
  const env: Record<string, string> = {
    PATH: `${AIDER_VENV}/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: workdir,
    OPENAI_API_BASE: options.apiBase,
    PYTHONUNBUFFERED: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C.UTF-8",
    LITELLM_LOCAL_MODEL_COST_MAP: "True",
    ...(options.envExtra ?? {}),
  };

  const args = [
    join(AIDER_VENV, "bin", "aider"),
    ...aiderCorpusArgs(options.apiBase, task.chatFiles).filter(
      (flag, index, all) => !(flag === "--model" || all[index - 1] === "--model"),
    ),
    "--model",
    options.model,
  ];
  const aider = await runProcess(
    args[0] ?? "aider",
    args.slice(1),
    workdir,
    env,
    `${task.turns.join("\n")}\n`,
  );

  const check = await runProcess(
    join(AIDER_VENV, "bin", "python"),
    ["check.py"],
    workdir,
    { PATH: `${AIDER_VENV}/bin:/usr/bin:/bin`, HOME: workdir, PYTHONUNBUFFERED: "1" },
    "",
    60_000,
  );
  const log = spawnSync("git", ["-C", workdir, "log", "--oneline"], { env: gitEnv });

  return {
    taskId: task.id,
    resolved: check.exitCode === 0,
    aiderReportedTokens: parseAiderTokens(`${aider.stdout}\n${aider.stderr}`),
    checkOutput: `${check.stdout}${check.stderr}`.trim(),
    turns: task.turns.length,
    aiderExitCode: aider.exitCode,
    aiderTail: aider.stdout.split("\n").slice(-30).join("\n"),
    commitCount: String(log.stdout ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0).length,
    durationMs: Date.now() - startedAt,
    workdir,
  };
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
