/**
 * Zeck CLI — developer primitives for submitting and inspecting
 * executions (WORK-015; acceptance criterion 3, M6).
 *
 * EXECUTION-CENTRIC + PROVIDER-NEUTRAL (M17/M18): every command operates
 * on the Execution abstraction through the SDK. There are no provider
 * commands (no model/provider/rail invocation from the shell).
 *
 * SECRET SAFETY (M6): credentials NEVER cross command-line flags (shell
 * history is a leak surface). The transport token comes from the
 * ZECK_TOKEN environment variable; the API base URL from ZECK_API_URL
 * (defaults to http://127.0.0.1:3000). The CLI never prints secret
 * material — it prints receipts, statuses, events, verification
 * evidence, costs and agent inventory.
 *
 * Commands:
 *   zeck submit   <applicationId> <taskJson> [--key <idempotencyKey>]
 *   zeck inspect  <applicationId> <executionId>
 *   zeck result   <applicationId> <executionId>
 *   zeck events   <applicationId> <executionId>
 *   zeck cost     <applicationId> <executionId>
 *   zeck verify   <applicationId> <executionId>
 *   zeck agents   <applicationId>
 *   zeck agent    <applicationId> <agentId>
 *   zeck cancel   <applicationId> <executionId> [--key <idempotencyKey>]
 */

import { createZeckClient, type ExecutionRequest, type ZeckApiError } from "../sdk";

const USAGE = `Usage:
  zeck submit  <applicationId> <taskJson> [--key <idempotencyKey>]
  zeck inspect <applicationId> <executionId>
  zeck result  <applicationId> <executionId>
  zeck events  <applicationId> <executionId>
  zeck cost    <applicationId> <executionId>
  zeck verify  <applicationId> <executionId>
  zeck cancel  <applicationId> <executionId> [--key <idempotencyKey>]
  zeck agents  <applicationId>
  zeck agent   <applicationId> <agentId>

Environment:
  ZECK_API_URL  the Zeck API base URL (default: http://127.0.0.1:3000)
  ZECK_TOKEN    the Zeck transport credential (NEVER a provider API key)`;

interface ParsedArgs {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[name] = "true";
      } else {
        flags[name] = next;
        index += 1;
      }
    } else {
      positional.push(arg);
    }
    index += 1;
  }
  const command = positional[0] ?? "";
  return { command, positional: positional.slice(1), flags };
}

function requireToken(): string {
  const token = process.env.ZECK_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error("error: ZECK_TOKEN is not set (the transport credential; never a provider key)");
    process.exit(1);
  }
  return token;
}

function makeClient() {
  return createZeckClient({
    baseUrl: process.env.ZECK_API_URL ?? "http://127.0.0.1:3000",
    token: requireToken(),
  });
}

function printError(error: unknown): void {
  if (error instanceof Error && error.name === "ZeckApiError") {
    const apiError = error as ZeckApiError;
    console.error(
      `error [${apiError.body.code}] (HTTP ${apiError.status}): ${apiError.body.message}`,
    );
    return;
  }
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
}

/** The CLI entry point (returns the process exit code). */
export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const [first, second] = args.positional;

  try {
    switch (args.command) {
      case "submit": {
        if (first === undefined || second === undefined) {
          console.error(USAGE);
          return 2;
        }
        const task = JSON.parse(second) as Record<string, unknown>;
        const request: ExecutionRequest = { applicationId: first, task };
        const { receipt } = await makeClient().createExecution(request, args.flags.key);
        console.log(
          `execution ${receipt.executionId} ${receipt.status} (sequence ${receipt.lastEventSequence}${receipt.replayed ? ", replayed" : ""})`,
        );
        return 0;
      }
      case "inspect": {
        if (first === undefined || second === undefined) {
          console.error(USAGE);
          return 2;
        }
        const execution = await makeClient().getExecution(second);
        console.log(
          [
            `execution ${execution.id}`,
            `status:   ${execution.status}`,
            `created:  ${execution.createdAt}`,
            execution.terminalAt === null ? "" : `terminal: ${execution.terminalAt}`,
            `task:     ${JSON.stringify(execution.task)}`,
          ]
            .filter((line) => line.length > 0)
            .join("\n"),
        );
        return 0;
      }
      case "result": {
        if (first === undefined || second === undefined) {
          console.error(USAGE);
          return 2;
        }
        const result = await makeClient().getResult(second);
        console.log(`execution ${result.executionId} — ${result.status}`);
        if (result.route !== null) {
          console.log(
            `route:    ${result.route.provider ?? "(deterministic)"}/${result.route.model ?? "-"} (${result.route.strategyClass ?? "?"}, ${result.route.modelCalls} model calls)`,
          );
        }
        if (result.cost !== null) {
          console.log(`cost:     ${result.cost.totalMicroUsd} micro-USD`);
        }
        for (const warning of result.warnings) {
          console.log(`warning:  ${warning}`);
        }
        return 0;
      }
      case "events": {
        if (first === undefined || second === undefined) {
          console.error(USAGE);
          return 2;
        }
        const events = await makeClient().listEvents(second);
        for (const event of events) {
          console.log(`#${event.sequence} ${event.type} @ ${event.occurredAt}`);
        }
        return 0;
      }
      case "cost": {
        if (first === undefined || second === undefined) {
          console.error(USAGE);
          return 2;
        }
        const result = await makeClient().getResult(second);
        console.log(
          result.cost === null
            ? "no settled cost facts on the execution ledger yet"
            : `total: ${result.cost.totalMicroUsd} micro-USD (${result.cost.currency})`,
        );
        return 0;
      }
      case "verify": {
        if (first === undefined || second === undefined) {
          console.error(USAGE);
          return 2;
        }
        const verification = await makeClient().listVerification(second);
        for (const result of verification) {
          console.log(
            `${result.status.padEnd(13)} ${result.criterionId} via ${result.strategy} (${result.evaluator.kind}:${result.evaluator.id})`,
          );
        }
        return 0;
      }
      case "cancel": {
        if (first === undefined || second === undefined) {
          console.error(USAGE);
          return 2;
        }
        const receipt = await makeClient().cancelExecution(second, args.flags.key);
        console.log(`execution ${receipt.executionId} ${receipt.status}`);
        return 0;
      }
      case "agents": {
        if (first === undefined) {
          console.error(USAGE);
          return 2;
        }
        const agents = await makeClient().listAgents();
        for (const agent of agents) {
          console.log(
            `${agent.slug.padEnd(24)} ${agent.status.padEnd(10)} active=${agent.activeVersion ?? "-"} ${agent.id}`,
          );
        }
        return 0;
      }
      case "agent": {
        if (first === undefined || second === undefined) {
          console.error(USAGE);
          return 2;
        }
        const status = await makeClient().getAgentStatus(second);
        console.log(`agent ${status.agent.slug} (${status.agent.id}) — ${status.agent.status}`);
        if (status.latestSelection !== null) {
          console.log(
            `selection: ${status.latestSelection.kind} -> ${status.latestSelection.selectedVersionId} @ ${status.latestSelection.selectedAt}`,
          );
        }
        for (const version of status.availableVersions) {
          console.log(
            `  ${version.version.padEnd(12)} ${version.validationState.padEnd(10)} ${version.definitionDigest.slice(0, 12)}…`,
          );
        }
        return 0;
      }
      case "help":
      case "--help":
        console.log(USAGE);
        return 0;
      default:
        console.error(USAGE);
        return 2;
    }
  } catch (error) {
    printError(error);
    return 1;
  }
}

// Direct-execution entry (bun run cli/index.ts …).
if (process.argv[1]?.endsWith("cli/index.ts") === true) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
