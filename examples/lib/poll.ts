/**
 * The shared lifecycle/presentation helpers for the example kit
 * (DEP-020): bounded polling to a terminal status, and an honest,
 * structured result printer (route, cost, usage, artifacts,
 * verification evidence, warnings — the full public result package).
 */

import {
  type ExecutionResult,
  type ExecutionStatus,
  TERMINAL_STATUSES,
  type ZeckApiError,
  type ZeckClient,
} from "../../sdk";

export interface PollOptions {
  /** Overall deadline (default 120000 ms). */
  readonly timeoutMs?: number;
  /** Interval between polls (default 1000 ms). */
  readonly intervalMs?: number;
  /** Clock seam (tests inject a deterministic one). */
  readonly now?: () => number;
  /** Sleep seam (tests inject an instant one). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const TERMINAL = TERMINAL_STATUSES as readonly string[];

/**
 * Poll the public execution read until a TERMINAL status (the polling
 * pattern of the validation harness — the wire contract exposes no
 * push channel for execution state; webhooks are the push surface).
 *
 * Fails with an actionable error when the deadline passes (the
 * execution is NOT terminal yet — its id is in the message so the
 * operator can keep polling or cancel).
 */
export async function awaitTerminalStatus(
  client: ZeckClient,
  executionId: string,
  options: PollOptions = {},
): Promise<ExecutionStatus> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = now() + timeoutMs;
  let last: ExecutionStatus | null = null;
  for (;;) {
    const execution = await client.getExecution(executionId);
    last = execution.status;
    if (TERMINAL.includes(execution.status)) {
      return execution.status;
    }
    if (now() >= deadline) {
      throw new Error(
        `execution ${executionId} did not reach a terminal status within ${timeoutMs} ms ` +
          `(last status: ${last}) — keep polling GET /executions/${executionId} ` +
          "or cancel via POST /executions/:id/cancel",
      );
    }
    await sleep(intervalMs);
  }
}

/** Micro-USD string → readable USD (display only; the wire stays integer strings). */
export function microUsdToUsdDisplay(microUsd: string): string {
  const value = Number.parseInt(microUsd, 10);
  if (Number.isNaN(value)) {
    return `invalid:${microUsd}`;
  }
  return `$${(value / 1_000_000).toFixed(6)} USD`;
}

/**
 * Print the honest end-state summary of one execution: the terminal
 * status, the route summary (opaque neutral provider/model strings),
 * the settled cost/usage facts (or their honest absence), the output
 * artifacts (id + digest), the verification evidence and the warnings
 * the platform itself surfaced.
 */
export function printExecutionSummary(executionId: string, result: ExecutionResult): void {
  console.log(`execution ${executionId}`);
  console.log(`  terminal status:   ${result.status} (at ${result.terminalAt ?? "unknown"})`);
  if (result.route === null) {
    console.log("  route:             (not recorded — no planning decision in the ledger)");
  } else {
    console.log(
      `  route:             provider=${result.route.provider ?? "n/a"} ` +
        `model=${result.route.model ?? "n/a"} strategy=${result.route.strategyClass ?? "n/a"} ` +
        `modelCalls=${result.route.modelCalls}`,
    );
  }
  if (result.cost === null) {
    console.log("  cost:              (not settled — no fabricated number is reported)");
  } else {
    console.log(
      `  cost:              ${result.cost.totalMicroUsd} micro-USD ` +
        `(${microUsdToUsdDisplay(result.cost.totalMicroUsd)})`,
    );
  }
  if (result.usage === null) {
    console.log("  usage:             (not reported by the rail)");
  } else {
    console.log(
      `  usage:             inputTokens=${result.usage.inputTokens} ` +
        `outputTokens=${result.usage.outputTokens}`,
    );
  }
  if (result.outputArtifacts.length === 0) {
    console.log("  artifacts:         (none)");
  } else {
    for (const artifact of result.outputArtifacts) {
      console.log(`  artifact:          ${artifact.id} (digest ${artifact.digest ?? "none"})`);
    }
  }
  if (result.verification.length === 0) {
    console.log("  verification:      (no criteria recorded)");
  } else {
    for (const verification of result.verification) {
      console.log(
        `  verification:      ${verification.criterionId} = ${verification.status} ` +
          `(strategy ${verification.strategy}, confidence ${
            verification.confidence === null ? "n/a" : verification.confidence
          })`,
      );
    }
  }
  if (result.warnings.length === 0) {
    console.log("  warnings:          (none)");
  } else {
    for (const warning of result.warnings) {
      console.log(`  warning:           ${warning}`);
    }
  }
}

/** Render a ZeckApiError honestly (code, HTTP status, retryability). */
export function describeZeckError(error: unknown): string {
  if (error instanceof Error && error.name === "ZeckApiError") {
    const apiError = error as ZeckApiError;
    return (
      `ZeckApiError ${apiError.status} ${apiError.body.code} ` +
      `(${apiError.body.retryable ? "retryable" : "not retryable"}): ${apiError.body.message}`
    );
  }
  return error instanceof Error ? error.message : String(error);
}
