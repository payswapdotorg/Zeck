/**
 * PPR-023 smoke: compose the proof stack + adapter, then run ONE real
 * `openclaw agent exec` one-shot through the certified config (the
 * scrubbed env + the deny proxy). Verifies the whole chain before the
 * battery: OpenClaw source runtime → --config pin → adapter → Zeck
 * public API → rail worker → model gateway → supply → back.
 *
 * Run: bun run compat/openclaw/harness/smoke.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { composeProofStack } from "./compose";
import { createAdapterServer } from "../adapter/server";
import {
  prepareTaskRun,
  runOpenClawCommand,
} from "./corpus-runner";
import { createEgressProxy } from "./egress-proxy";
import { CORPUS_TASKS } from "../corpus/tasks";

const WORK_ROOT = "/tmp/ppr-023-smoke";

async function main(): Promise<void> {
  mkdirSync(WORK_ROOT, { recursive: true });
  console.log("[smoke] composing the proof stack…");
  const stack = await composeProofStack({ minDispatchIntervalMs: 1500 });
  const adapter = await createAdapterServer({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
  });
  const proxy = await createEgressProxy();
  console.log(`[smoke] api=${stack.apiBaseUrl} adapter=${adapter.url} proxy=${proxy.url}`);
  try {
    const task = CORPUS_TASKS.find((entry) => entry.taskId === "implement-edit");
    if (task === undefined) {
      throw new Error("implement-edit task missing from the corpus");
    }
    const dirs = prepareTaskRun(WORK_ROOT, task, adapter.url, undefined);
    task.fixture(dirs.workdir);
    adapter.setRunContext({ corpusTask: "smoke", runLabel: "smoke" });
    console.log("[smoke] running `openclaw agent exec` (implement-edit)…");
    const startedAt = Date.now();
    const result = await runOpenClawCommand(
      {
        proxy,
        // The app's own documented env axis (src/plugins/bundled-dir.ts):
        // disable bundled-plugin discovery — the smoke's task (the agent
        // loop) is a core surface; the certified runtime stays tighter
        // (zero dormant provider plugins loaded).
        extraEnv: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      },
      dirs.home,
      dirs.stateDir,
      dirs.configPath,
      dirs.workdir,
      [
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
      ],
      420_000,
    );
    console.log(
      `[smoke] exit=${result.exitCode} timedOut=${result.timedOut} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
    console.log(`[smoke] stdout:\n${result.stdout.slice(0, 2500)}`);
    console.log(`[smoke] FULL stderr:\n${result.stderr}`);
    const verification = task.verify({
      workdir: dirs.workdir,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
    console.log(`[smoke] verification: ${verification.resolved} — ${verification.checkOutput}`);
    const logs = adapter.requests();
    console.log(
      `[smoke] adapter requests: ${logs.length} — ${logs
        .map((log) => `${log.edgeId}→${log.executionId}(${log.terminal}${log.replayed ? ",replay" : ""})`)
        .join(" | ")}`,
    );
    console.log(`[smoke] egress violations: ${proxy.violations().length}`);
  } finally {
    adapter.close();
    proxy.close();
    await stack.close();
  }
}

main().catch((error) => {
  console.error("[smoke] FAILED:", error);
  process.exit(1);
});
