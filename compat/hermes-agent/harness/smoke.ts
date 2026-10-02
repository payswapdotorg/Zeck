/**
 * The PPR-022 composition smoke test — one real Hermes one-shot turn
 * through the composed proof stack (Zeck public API + model gateway +
 * multi-surface rail + adapter + deny proxy), exercising the main edge
 * and the automatic title edge. Development-time tooling only.
 */
import { composeProofStack } from "../harness/compose";
import { createAdapterServer } from "../adapter/server";
import { createEgressProxy } from "../harness/egress-proxy";
import { runOneShot, writeHermesConfig } from "../harness/corpus-runner";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

async function main(): Promise<void> {
  const root = "/tmp/ppr-022-smoke";
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "work"), { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });

  const stack = await composeProofStack({ minDispatchIntervalMs: 800, retryCooldownMs: 4000 });
  const adapter = await createAdapterServer({
    apiBaseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
  });
  const proxy = await createEgressProxy();
  console.log(`api=${stack.apiBaseUrl} adapter=${adapter.url} proxy=${proxy.url}`);

  writeHermesConfig(
    join(root, "home"),
    adapter.url,
    // A trivial task spec: default axes.
    {
      taskId: "smoke",
      title: "smoke",
      spec: { instruction: "", toolsets: "" },
      fixture: () => {},
      verify: () => ({ resolved: true, checkOutput: "n/a" }),
    },
  );

  const result = await runOneShot(
    { proxy },
    join(root, "work"),
    join(root, "home"),
    "Reply with exactly: SMOKE-OK",
    "todo",
  );
  console.log("=== hermes -z exit", result.exitCode, "===");
  console.log("stdout:", result.stdout.slice(-500));
  console.log("stderr tail:", result.stderr.slice(-800));
  console.log("=== adapter logs ===");
  for (const log of adapter.requests()) {
    console.log(
      `${log.surface} ${log.edgeId} -> ${log.executionId} terminal=${log.terminal} replayed=${log.replayed} chars=${log.contentChars}`,
    );
  }
  console.log("=== rail facts ===");
  for (const fact of stack.railFacts()) {
    console.log(`${fact.executionId} ${fact.outcome} usage=${JSON.stringify(fact.usage)}`);
  }
  console.log("=== egress violations ===", proxy.violations().length);

  adapter.close();
  proxy.close();
  await stack.close();
}

main().catch((error) => {
  console.error("SMOKE FAILED:", error);
  process.exit(1);
});
