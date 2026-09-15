/**
 * The economic-actions example (DEP-020 / WORK-032 surface).
 *
 * One sentence: propose a bounded, capability-gated payment INTENT that
 * is provenance-bound to a completed execution, then read its durable
 * record, its event ledger and its outcome (settlement and delivery
 * reported as SEPARATE axes — payment success != resource delivered).
 *
 * SDK NOTE (honest surface mapping): the execution-centric SDK client
 * covers the execution core; the economic-action REST surface is ridden
 * directly with `fetch` using the SAME wire types the SDK re-exports
 * (EconomicAction, EconomicActionReceipt, …) and the SAME conventions:
 * bearer auth, X-Zeck-Application on scoped reads, Idempotency-Key on
 * POST. See docs/developer/ECONOMICS.md.
 *
 * Classification: runnable (intent creation and reads are durable
 * platform operations; settlement observations require an external rail
 * correlation the platform records as evidence only).
 */

import type { EconomicAction, EconomicActionReceipt } from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "economic-actions",
  family: "workflow",
  title: "Economic actions — bounded, execution-bound payment intent",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

/** The minimal authenticated fetch over the public REST surface. */
async function apiCall<T>(
  env: ZeckEnv,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const response = await fetch(`${env.apiBaseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.token}`,
      "content-type": "application/json",
      "x-zeck-application": env.applicationId,
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`economic-action call failed (${response.status}): ${text}`);
  }
  return (await response.json()) as T;
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  // 1. A completed execution the intent is provenance-bound to (the
  //    platform rejects an intent for a nonexistent execution).
  const client = createClient(env);
  const { receipt } = await client.createExecution(
    {
      applicationId: env.applicationId,
      task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
      constraints: { maxCostMicroUsd: "5000" },
      metadata: { family: "economics", example: EXAMPLE.name },
    },
    `${EXAMPLE.name}-exec-1`,
  );
  await awaitTerminalStatus(client, receipt.executionId, { timeoutMs: 120_000 });

  // 2. Propose the intent: an EXACT bounded amount (integer micro-USD
  //    string), an OPAQUE recipient reference (never a credential —
  //    there is no field where a raw payment credential could appear),
  //    and the capabilities the intent requires.
  const proposed = await apiCall<EconomicActionReceipt>(
    env,
    "POST",
    "/economic-actions",
    {
      applicationId: env.applicationId,
      executionId: receipt.executionId,
      purpose: "purchase dataset access (example)",
      recipient: { kind: "external-account", id: "vendor-001" },
      amount: { kind: "exact", microUsd: "1500000" }, // $1.50 — micro-USD integer string
      currency: "usd",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      requiredCapabilities: [{ kind: "tool", name: "human-review" }],
      metadata: { example: EXAMPLE.name },
    },
    `${EXAMPLE.name}-intent-1`,
  );
  console.log(
    `proposed economic action ${proposed.economicActionId} ` +
      `(status ${proposed.status}, replayed=${proposed.replayed})`,
  );

  // 3. Read the durable intent record (scoped read: X-Zeck-Application).
  const action = await apiCall<EconomicAction>(
    env,
    "GET",
    `/economic-actions/${encodeURIComponent(proposed.economicActionId)}`,
  );
  console.log(
    `durable record: status=${action.status} purpose="${action.purpose}" ` +
      `amount=${JSON.stringify(action.amount)} recipient=${action.recipient.kind}:${action.recipient.id}`,
  );

  // 4. The intent's own event ledger (the per-action provenance chain).
  const events = await apiCall<readonly unknown[]>(
    env,
    "GET",
    `/economic-actions/${encodeURIComponent(proposed.economicActionId)}/events`,
  );
  console.log(`economic-action ledger: ${events.length} event(s)`);

  // 5. The outcome: settlement and delivery are SEPARATE axes — a
  //    settlement alone never proves delivery.
  const outcome = await apiCall<{
    readonly settlement: unknown;
    readonly deliveries: readonly unknown[];
  }>(env, "GET", `/economic-actions/${encodeURIComponent(proposed.economicActionId)}/outcome`);
  console.log(
    `outcome: settlement=${outcome.settlement === null ? "none observed" : "observed"}; ` +
      `deliveries=${outcome.deliveries.length}`,
  );
  console.log(
    "note: authorization and settlement flow through the governed admission " +
      "chain (policy → capability → budget) — proposing an intent is NEVER " +
      "an authorization; see docs/developer/ECONOMICS.md",
  );
}

runWhenInvoked(import.meta.url, () => main());
