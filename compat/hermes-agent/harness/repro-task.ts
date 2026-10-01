/**
 * PPR-022 live reproduction harness — composes the SAME proof stack the
 * battery composes and runs ONE corpus task's exact one-shot command,
 * capturing the FULL stdout/stderr (diagnosis only; never part of the
 * certified battery — a diagnostic tool, not a proof fact source).
 *
 * Usage: bun run compat/hermes-agent/harness/repro-task.ts <taskId>
 */
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { composeProofStack } from "./compose";
import { createAdapterServer } from "../adapter/server";
import { createEgressProxy } from "./egress-proxy";
import {
  runOneShot,
  runMediaDriver,
  writeHermesConfig,
  HERMES_VENV_DIR,
} from "./corpus-runner";
import { CORPUS_TASKS } from "../corpus/tasks";

const taskId = process.argv[2] ?? "context-compaction";
const task = CORPUS_TASKS.find((t) => t.taskId === taskId);
if (task === undefined) {
  throw new Error(`unknown task ${taskId}`);
}

const WORK = "/tmp/ppr-022-repro";
const workdir = join(WORK, task.taskId);
const home = join(WORK, `${task.taskId}-home`);
rmSync(workdir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
mkdirSync(workdir, { recursive: true });
mkdirSync(home, { recursive: true });
task.fixture(workdir);

const stack = await composeProofStack({
  minDispatchIntervalMs: 500,
  retryCooldownMs: 5_000,
});
const adapter = await createAdapterServer({
  apiBaseUrl: stack.apiBaseUrl,
  token: stack.apiToken,
  applicationId: stack.applicationId,
});
const proxy = await createEgressProxy();
writeHermesConfig(home, adapter.url, task);
console.log(`[repro] task=${task.taskId} adapter=${adapter.url} proxy=${proxy.url}`);

try {
  const driverOptions = { proxy, venvPath: HERMES_VENV_DIR as string, runTimeoutMs: 300_000 };
  const result =
    task.taskId === "transcribe-memo"
      ? await runMediaDriver(driverOptions, workdir, home, join(workdir, "voice-memo.wav"))
      : await runOneShot(driverOptions, workdir, home, task.spec.instruction, task.spec.toolsets);
  console.log(`[repro] exit=${result.exitCode} timedOut=${result.timedOut}`);
  console.log(`[repro] adapter requests: ${adapter.requests().length}`);
  for (const log of adapter.requests()) {
    console.log(
      `  ${log.surface} ${log.edgeId} -> ${log.terminal} (exec ${log.executionId.slice(-4)})`,
    );
  }
  const violations = proxy.violations();
  console.log(`[repro] egress violations: ${violations.length}`);
  for (const v of violations) {
    console.log(`  ${v.host} ${v.blocked ? "BLOCKED" : "ALLOWED"} ${v.url.slice(0, 80)}`);
  }
  console.log(`[repro] FULL STDERR (${result.stderr.length} chars):\n${result.stderr.slice(-4000)}`);
  console.log(`[repro] STDOUT tail:\n${result.stdout.slice(-1500)}`);
  // Full dumps for diagnosis:
  const { writeFileSync: wf } = await import("node:fs");
  wf(`/tmp/ppr-022-repro-${task.taskId}-full-stdout.log`, result.stdout);
  wf(`/tmp/ppr-022-repro-${task.taskId}-full-stderr.log`, result.stderr);
  const verification = task.verify({
    workdir,
    home,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  });
  console.log(`[repro] verification: ${verification.resolved ? "RESOLVED" : "UNRESOLVED"} — ${verification.checkOutput}`);
} finally {
  adapter.close();
  proxy.close();
  await stack.close();
}
