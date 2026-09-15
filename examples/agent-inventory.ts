/**
 * The agent inventory projection (DEP-020): list the governed agents of
 * your application and inspect one agent's status view (active version,
 * validation state, latest promotion/rollback selection).
 *
 * One sentence: the /agents surface is a READ-ONLY governed projection —
 * agent identity, versions and promotions change through their owning
 * authorities, never through the public API.
 *
 * Classification: runnable.
 */

import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "agent-inventory",
  family: "workflow",
  title: "Agents — governed inventory and status projection",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  const client = createClient(env);

  // GET /agents — every agent of the application scope (the header the
  // SDK sends from the client's applicationId).
  const agents = await client.listAgents();
  console.log(`agent inventory: ${agents.length} agent(s)`);
  for (const agent of agents) {
    console.log(
      `  ${agent.slug} (${agent.id}) status=${agent.status} ` +
        `activeVersion=${agent.activeVersion ?? "none"}`,
    );
  }
  if (agents.length === 0) {
    console.log("  (no agents registered for this application yet)");
    return;
  }

  // GET /agents/:id/status — the full status view: agent summary, the
  // active version (with its validation state), the latest
  // promotion/rollback selection and every available version.
  const first = agents[0];
  if (first === undefined) {
    return;
  }
  const status = await client.getAgentStatus(first.id);
  console.log(`agent status view for ${status.agent.slug}:`);
  console.log(`  lifecycle:            ${status.agent.status}`);
  console.log(
    `  active version:       ${
      status.activeVersion === null
        ? "none"
        : `${status.activeVersion.version} (${status.activeVersion.validationState}, digest ${status.activeVersion.definitionDigest})`
    }`,
  );
  console.log(
    `  latest selection:     ${
      status.latestSelection === null
        ? "none"
        : `${status.latestSelection.kind} at ${status.latestSelection.selectedAt}`
    }`,
  );
  console.log(`  available versions:   ${status.availableVersions.length}`);
}

runWhenInvoked(import.meta.url, () => main());
