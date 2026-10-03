/**
 * PPR-023 memory probe — the diagnostic that isolated the certified-run
 * OOM (kept as the documented debug artifact; NOT part of the battery).
 *
 * Runs the identical certified command (implement-edit task) with the
 * scrubbed env, sampling the child's RSS + the system's available memory
 * in-process, sending SIGUSR2 at a chosen time (Node diagnostic report —
 * JS heap spaces, external memory, isolates, stacks land in the task
 * workdir), and SIGKILLing before the kernel's OOM killer would.
 *
 * Modes:
 *   preload    — the exact certified env (NODE_OPTIONS preload + heap cap)
 *   no-preload — NODE_OPTIONS emptied (the control arm that isolates the
 *                loader redirect's contribution)
 *
 * Run: bun run compat/openclaw/harness/mem-probe.ts [preload|no-preload] [usr2_seconds] [kill_seconds]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_TASKS } from "../corpus/tasks";
import {
  OPENCLAW_RUN_PREFIX,
  prepareTaskRun,
  scrubbedOpenClawEnv,
  writeOpenClawConfig,
} from "./corpus-runner";
import { composeProofStack } from "./compose";
import { createAdapterServer } from "../adapter/server";
import { createEgressProxy } from "./egress-proxy";

const WORK_ROOT = "/tmp/ppr-023-mem-probe";
const mode = process.argv[2] === "no-preload" ? "no-preload" : "preload";
const usr2AfterMs = Number(process.argv[3] ?? 50) * 1000;
const killAfterMs = Number(process.argv[4] ?? 76) * 1000;

function availableMemMb(): number {
  const fields = readFileSync("/proc/meminfo", "utf8").split("\n");
  let memAvailable = 0;
  for (const line of fields) {
    const match = /^MemAvailable:\s+(\d+) kB/.exec(line);
    if (match) {
      memAvailable = Number(match[1]) / 1024;
    }
  }
  return memAvailable;
}

function childRssKb(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+) kB/.exec(status);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

async function main(): Promise<void> {
  mkdirSync(WORK_ROOT, { recursive: true });
  const task = CORPUS_TASKS.find((entry) => entry.taskId === "implement-edit");
  if (task === undefined) {
    throw new Error("implement-edit task missing from the corpus");
  }
  console.log(`[probe] mode=${mode} usr2@${usr2AfterMs / 1000}s kill@${killAfterMs / 1000}s`);
  const stack = await composeProofStack({ minDispatchIntervalMs: 1500 });
  const adapter = await createAdapterServer({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
  });
  const proxy = await createEgressProxy();
  console.log(`[probe] adapter=${adapter.url}`);
  try {
    const dirs = prepareTaskRun(WORK_ROOT, task, adapter.url, undefined, join(WORK_ROOT, "shared-state"));
    task.fixture(dirs.workdir);
    const env = scrubbedOpenClawEnv({
      proxyUrl: proxy.url,
      home: dirs.home,
      stateDir: dirs.stateDir,
      configPath: dirs.configPath,
    });
    if (mode === "no-preload") {
      delete (env as Record<string, string | undefined>).NODE_OPTIONS;
    }
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
      task.surface.kind === "agent-exec" ? task.surface.instruction : "",
    ];
    const child = spawn("node", ["--report-on-signal", ...argv], {
      cwd: dirs.workdir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      const rss = childRssKb(child.pid ?? -1);
      console.log(
        `[probe] t=${((Date.now() - startedAt) / 1000).toFixed(1)}s rss=${(rss / 1024).toFixed(0)}MB avail=${availableMemMb().toFixed(0)}MB adapterReq=${adapter.requests().length}`,
      );
    }, 5000);
    const sendUsr2 = setTimeout(() => {
      console.log(`[probe] sending SIGUSR2 (diagnostic report) to ${child.pid}`);
      try {
        child.kill("SIGUSR2");
      } catch {
        console.log("[probe] SIGUSR2 failed (process gone?)");
      }
    }, usr2AfterMs);
    const hardKill = setTimeout(() => {
      console.log("[probe] hard SIGKILL (pre-empting the kernel OOM killer)");
      try {
        const tree = spawnSync("ps", ["-eo", "pid,ppid,rss,etime,args", "--sort=-rss"], {
          encoding: "utf8",
        });
        const lines = (tree.stdout ?? "").split("\n").slice(0, 14);
        console.log(`[probe] process tree at kill:\n${lines.join("\n")}`);
      } catch {
        console.log("[probe] ps dump failed");
      }
      // Dump every descendant's environ + smaps_rollup: did the ballooning
      // grandchild inherit NODE_OPTIONS (preload + heap cap)?
      try {
        const procs = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
        for (const procPid of procs) {
          try {
            const stat = readFileSync(`/proc/${procPid}/stat`, "utf8");
            const ppidField = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1];
            if (ppidField !== String(child.pid)) {
              continue;
            }
            const cmdline = readFileSync(`/proc/${procPid}/cmdline`, "utf8").replace(/\0/g, " ");
            const environ = readFileSync(`/proc/${procPid}/environ`, "utf8");
            const nodeOptions = /NODE_OPTIONS=([^\0]*)/.exec(environ)?.[1] ?? "(absent)";
            const rss = /VmRSS:\s+(\d+) kB/.exec(
              readFileSync(`/proc/${procPid}/status`, "utf8"),
            )?.[1];
            console.log(
              `[probe] descendant ${procPid} rss=${rss}kB\n      cmd=${cmdline.slice(0, 300)}\n      NODE_OPTIONS=${nodeOptions}`,
            );
          } catch {
            // process exited mid-scan — skip it
          }
        }
      } catch {
        console.log("[probe] descendant scan failed");
      }
      child.kill("SIGKILL");
    }, killAfterMs);
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", (exitCode) => {
        resolve(exitCode);
      });
    });
    clearInterval(timer);
    clearTimeout(sendUsr2);
    clearTimeout(hardKill);
    console.log(`[probe] child exited code=${code}`);
    console.log(`[probe] stdout tail: ${out.slice(-500)}`);
    console.log(`[probe] stderr tail: ${err.slice(-500)}`);
    const reports = readdirSync(dirs.workdir).filter((name) => name.startsWith("report."));
    if (reports.length > 0) {
      const reportPath = join(dirs.workdir, reports[reports.length - 1]!);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
      console.log(`[probe] report file: ${reportPath}`);
      console.log(
        `[probe] report.memory: ${JSON.stringify(report.memory ?? {}, null, 1).slice(0, 1200)}`,
      );
      const jsStacks = JSON.stringify(report.javascriptStack ?? {}, null, 1);
      console.log(`[probe] js stack head: ${jsStacks.slice(0, 900)}`);
    } else {
      console.log("[probe] no report file found in workdir");
    }
    if (!existsSync(join(WORK_ROOT, "keep-stack"))) {
      await stack.close();
    }
  } finally {
    adapter.close();
    proxy.close();
  }
}

main().catch((error) => {
  console.error("[probe] FAILED:", error);
  process.exit(1);
});
