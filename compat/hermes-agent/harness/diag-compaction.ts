/**
 * PPR-022 diagnostic — re-run ONLY the context-compaction corpus task with
 * `hermes --debug` and capture the compressor's full decision trace, to
 * explain why run 3 (18:01Z battery pass) recorded zero
 * hermes.auxiliary.compression executions while the milestone-5 repro
 * recorded two.
 *
 * Mirrors runOneTask's composition exactly (fixture → writeHermesConfig →
 * scrubbed env → one-shot hermes) with ONE addition: the --debug CLI flag.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAdapterServer } from "../adapter/server";
import { CORPUS_TASKS } from "../corpus/tasks";
import { composeProofStack } from "./compose";
import { createEgressProxy } from "./egress-proxy";
import { HERMES_VENV_DIR, scrubbedHermesEnv, writeHermesConfig } from "./corpus-runner";

const task = CORPUS_TASKS.find((t) => t.taskId === "context-compaction");
if (task === undefined) {
  throw new Error("context-compaction task not found");
}

const WORK = "/tmp/ppr-022-diag-compaction";
rmSync(WORK, { recursive: true, force: true });
const workdir = join(WORK, "work");
const home = join(WORK, "home");
mkdirSync(workdir, { recursive: true });
mkdirSync(home, { recursive: true });

console.log("[diag] composing proof stack…");
const stack = await composeProofStack({ minDispatchIntervalMs: 2000, retryCooldownMs: 15_000 });
const adapter = await createAdapterServer({
  apiBaseUrl: stack.apiBaseUrl,
  token: stack.apiToken,
  applicationId: stack.applicationId,
});
const proxy = await createEgressProxy();
console.log(`[diag] api=${stack.apiBaseUrl} adapter=${adapter.url} proxy=${proxy.url}`);

writeHermesConfig(home, adapter.url, task);
task.fixture(workdir);

const env = scrubbedHermesEnv({ proxyUrl: proxy.url, home, venvPath: HERMES_VENV_DIR });
const args = ["-z", task.spec.instruction];
if (task.spec.toolsets.length > 0) {
  args.push("-t", task.spec.toolsets);
}

console.log(`[diag] spawning hermes --debug (${task.taskId})…`);
const startedAt = Date.now();
await new Promise<void>((resolve) => {
  const child = spawn(join(HERMES_VENV_DIR, "bin", "hermes"), args, {
    cwd: workdir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  child.stderr?.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
  }, 420_000);
  child.on("close", (code) => {
    clearTimeout(timer);
    writeFileSync(join(WORK, "stdout.log"), out);
    writeFileSync(join(WORK, "stderr.log"), err);
    console.log(`[diag] exit=${code ?? -1} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s; stdout/stderr written to ${WORK}`);
    resolve();
  });
});

console.log("\n[diag] adapter request log:");
for (const r of adapter.requests()) {
  console.log(`  ${r.surface} ${r.edgeId} -> ${r.terminal} (exec ${r.executionId})`);
}
const verdict = task.verify({ workdir });
console.log(`\n[diag] verification: ${verdict.resolved ? "RESOLVED" : "UNRESOLVED"} — ${verdict.checkOutput}`);
const compressionEdges = adapter.requests().filter((r) => r.edgeId === "hermes.auxiliary.compression");
console.log(`[diag] compression-edge requests: ${compressionEdges.length}`);

adapter.close();
proxy.close();
await stack.close();
