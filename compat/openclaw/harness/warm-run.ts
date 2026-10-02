/**
 * PPR-023 warm-up runner — the minimal certified-env spawn WITHOUT the
 * proof harness's composed stack (no adapter/rail memory overhead), used
 * to prime the pinned runtime's persistent state (plugin index / model
 * catalog) that cold starts rebuild at multi-GB cost. The model call at
 * the end points at a dead loopback endpoint and is EXPECTED to fail;
 * the priming is what this run is for.
 *
 * Run: bun run compat/openclaw/harness/warm-run.ts [fresh|keep] [extra NODE_OPTIONS]
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OPENCLAW_RUN_PREFIX,
  prepareTaskRun,
  scrubbedOpenClawEnv,
  writeOpenClawConfig,
} from "./corpus-runner";
import { CORPUS_TASKS } from "../corpus/tasks";

const WORK_ROOT = "/tmp/ppr-023-warm";
const mode = process.argv[2] === "keep" ? "keep" : "fresh";
const extraNodeOptions = process.argv[3] ?? "";

function availableMemMb(): number {
  const match = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return match ? Number(match[1]) / 1024 : -1;
}

function rssKb(pid: number | undefined): number {
  if (pid === undefined) {
    return -1;
  }
  try {
    const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  if (mode === "fresh") {
    const { spawnSync } = await import("node:child_process");
    spawnSync("rm", ["-rf", WORK_ROOT]);
  }
  mkdirSync(WORK_ROOT, { recursive: true });
  const task = CORPUS_TASKS.find((entry) => entry.taskId === "implement-edit");
  if (task === undefined) {
    throw new Error("implement-edit task missing from the corpus");
  }
  const dirs = prepareTaskRun(WORK_ROOT, task, "http://127.0.0.1:9/v1", undefined, join(WORK_ROOT, "shared-state"));
  task.fixture(dirs.workdir);
  const env = scrubbedOpenClawEnv({
    proxyUrl: "http://127.0.0.1:8/", // deny-everything placeholder (no live proxy in this runner)
    home: dirs.home,
    stateDir: dirs.stateDir,
    configPath: dirs.configPath,
  });
  if (extraNodeOptions.length > 0) {
    (env as Record<string, string>).NODE_OPTIONS = `${env.NODE_OPTIONS} ${extraNodeOptions}`;
  }
  console.log(`[warm] mode=${mode} NODE_OPTIONS=${env.NODE_OPTIONS}`);
  const argv = [
    ...OPENCLAW_RUN_PREFIX,
    "agent",
    "exec",
    "--config",
    dirs.configPath,
    "--state-dir",
    dirs.stateDir,
    "--cwd",
    dirs.workdir,
    "--json",
    "Reply with the single word: ready.",
  ];
  const child = spawn("node", argv, { cwd: dirs.workdir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  const startedAt = Date.now();
  const timer = setInterval(() => {
    console.log(
      `[warm] t=${((Date.now() - startedAt) / 1000).toFixed(0)}s main rss=${(rssKb(child.pid) / 1024).toFixed(0)}MB avail=${availableMemMb().toFixed(0)}MB`,
    );
  }, 5000);
  const code = await new Promise<number | null>((resolve) => {
    child.on("close", (exitCode) => {
      resolve(exitCode);
    });
  });
  clearInterval(timer);
  console.log(`[warm] exited code=${code} after ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  console.log(`[warm] stdout tail: ${out.slice(-400)}`);
  console.log(`[warm] stderr tail: ${err.slice(-600)}`);
}

main().catch((error) => {
  console.error("[warm] FAILED:", error);
  process.exit(1);
});
