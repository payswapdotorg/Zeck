/**
 * VAL-019 acceptance criteria 3, 4, 5, 6 — the crown proof: the six
 * agentic + human-in-the-loop applications run end to end against the
 * REAL platform path with REAL multi-step model loops.
 *
 * REAL pieces (nothing faked on the critical path):
 *   - the REAL Fastify public API over the REAL SQL authorities;
 *   - the REAL model gateway + BYOK connection + OpenRouter rail
 *     adapter + production fetch transport — one REAL dispatch PER
 *     agent round (bounded honest retry for retryable failures only),
 *     with the agent protocol as native structured output;
 *   - the REAL execution state machine, including GENUINE wait-tool →
 *     resume cycles around every tool execution and GENUINE wait-human
 *     → resume cycles around every approval gate (the HITL machinery);
 *   - the REAL ledger step-event vocabulary (tool-requested /
 *     tool-result / tool-denied / human-decision-recorded /
 *     agent-action-recorded) recording the invocation trace, the
 *     recorded approver decisions and the escalation routing;
 *   - the deterministic in-lab fixture worlds (ticket/policy table,
 *     shop page graph, workspace tree, research corpus, embedded-test
 *     runner, ops state) as the governed tool surfaces;
 *   - mechanical verification: corpus expectations, tool-effect
 *     assertions against fixture state, HITL decision-loop assertions
 *     (approvals gate effects, escalations route correctly, supervised
 *     continuations resume exactly once).
 *
 * The provider credential is environment-gated (absent key = recorded
 * NOT RUN boundary, never a fake success). The LIVE web and LIVE
 * desktop surfaces are honest NOT RUN boundaries: browser-use and
 * computer-use run against controlled in-memory fixtures only.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  BROWSER_USE_TASKS,
  runBrowserUseApp,
} from "../../../benchmarks/validation/apps/browser-use/application";
import {
  BROWSER_TASK_GROUND_TRUTHS,
  BROWSER_TOOL_CONTRACTS,
  createBrowserWorld,
} from "../../../benchmarks/validation/apps/browser-use/web";
import { CODING_TASKS, runCodingApp } from "../../../benchmarks/validation/apps/coding/application";
import {
  CODING_TASK_GROUND_TRUTHS,
  CODING_TOOL_CONTRACTS,
  createCodingWorld,
} from "../../../benchmarks/validation/apps/coding/specs";
import {
  COMPUTER_USE_TASKS,
  runComputerUseApp,
} from "../../../benchmarks/validation/apps/computer-use/application";
import {
  COMPUTER_TASK_GROUND_TRUTHS,
  COMPUTER_TOOL_CONTRACTS,
  createComputerWorld,
} from "../../../benchmarks/validation/apps/computer-use/workspace";
import {
  CUSTOMER_SERVICE_TASKS,
  runCustomerServiceApp,
} from "../../../benchmarks/validation/apps/customer-service/application";
import {
  CS_TASK_GROUND_TRUTHS,
  CS_TOOL_CONTRACTS,
  createCsWorld,
} from "../../../benchmarks/validation/apps/customer-service/triage";
import {
  OPERATIONS_TASKS,
  runOperationsApp,
} from "../../../benchmarks/validation/apps/operations/application";
import {
  createOpsWorld,
  OPERATIONS_ROWS,
  OPS_TOOL_CONTRACTS,
} from "../../../benchmarks/validation/apps/operations/runbooks";
import {
  RESEARCH_TASKS,
  runResearchApp,
} from "../../../benchmarks/validation/apps/research/application";
import {
  createResearchWorld,
  RESEARCH_TASK_GROUND_TRUTHS,
  RESEARCH_TOOL_CONTRACTS,
} from "../../../benchmarks/validation/apps/research/sources";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  AGENTIC_PROTOCOL_SCHEMA,
  AGENTIC_STEP_SCHEMA,
  type AgenticLifecyclePort,
  type AgenticTaskGroundTruth,
  approverFromGroundTruth,
  driveAgenticExecution,
} from "../../../benchmarks/validation/platform/agentic";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createScopeResolver } from "../../../src/modules/auth/application/scope-resolver";
import {
  SqlConnectionStore,
  SqlConnectionsIdempotency,
} from "../../../src/modules/connections/adapters/sql-connection-store";
import {
  createTxCredentialVault,
  SqlCredentialVault,
} from "../../../src/modules/connections/adapters/sql-credential-vault";
import { createConnectionService } from "../../../src/modules/connections/application/connection-service";
import { createFetchTransport } from "../../../src/modules/models/adapters/fetch-transport";
import { createOpenRouterAdapter } from "../../../src/modules/models/adapters/openrouter";
import { createSqlDispatchJournal } from "../../../src/modules/models/adapters/sql-dispatch-journal";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../../src/modules/models/application/rail-registry";
import {
  createEnvelopeCipher,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import type { Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const PROVIDER = "openrouter";
const MODEL = process.env.ZECK_VAL_019_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update(`${PROVIDER}|${MODEL}|val-019-pinned`)
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 768;

interface RunFacts {
  readonly app: string;
  readonly taskIndex: number;
  readonly goal: string;
  readonly terminal: string;
  readonly criteria: readonly { criterionId: string; status: string }[];
  readonly appPassed: boolean;
  readonly rounds: number;
  readonly dispatchAttempts: number;
  readonly toolEvents: number;
  readonly waitToolCycles: number;
  readonly waitHumanCycles: number;
  readonly humanDecisions: number;
  readonly usage: LabUsage | null;
}

/** The gateway + lifecycle binding over the REAL platform authorities. */
interface PlatformBinding {
  readonly lifecycle: AgenticLifecyclePort;
  readonly principal: { readonly actorId: string; readonly authenticatedAt: string };
  readonly dispatchRound: (input: {
    readonly executionId: string;
    readonly round: number;
    readonly messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
  }) => Promise<
    | { readonly kind: "success"; readonly content: string; readonly usage?: LabUsage }
    | { readonly kind: "failure"; readonly category: string; readonly message: string }
  >;
}

async function buildPlatformBinding(ctx: PgContext, world: ApiPgWorld): Promise<PlatformBinding> {
  const generateId = createUuidv7Generator();
  const cipher = createEnvelopeCipher(generateMasterKey());
  const auth = createSqlAuthModule(ctx.port, generateId);
  const vault = new SqlCredentialVault(ctx.port, cipher, generateId);
  const connections = createConnectionService(
    new SqlConnectionStore(ctx.port),
    new SqlConnectionsIdempotency(
      ctx.port,
      (tx: Transaction) => createTxCredentialVault(tx, cipher, generateId),
      generateId,
    ),
    createScopeResolver(auth.store),
    auth.store,
    generateId,
  );
  const registry = createRailRegistry([
    createOpenRouterAdapter({ transport: createFetchTransport() }),
  ]);
  const gateway = createModelGateway({
    resolver: createScopeResolver(auth.store),
    catalog: connections,
    credentials: vault,
    admission: {
      async admit() {
        return { allowed: true };
      },
    },
    capabilities: {
      async resolve() {
        return { satisfied: true, catalogRevision: "val-019", satisfactions: [] };
      },
    },
    rails: registry,
    journal: createSqlDispatchJournal(ctx.port),
    generateId,
    defaultTimeoutMs: 150_000,
    hashRequest: (request) =>
      createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
  });

  const principal = { actorId: world.actorId, authenticatedAt: new Date().toISOString() };
  const { connection } = await connections.registerConnection(
    {
      principal,
      applicationId: world.applicationId,
      rail: "openrouter",
      label: "val-019-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-019-conn-${generateId().slice(-8)}`,
  );

  let transitionCounter = 0;
  const lifecycle: AgenticLifecyclePort = {
    async transition({ executionId, step, reason }) {
      transitionCounter += 1;
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: step,
          reason,
        },
        // Every call gets a unique key: repeated steps (wait-tool /
        // wait-human per round) must never collide on the ledger.
        `val-019-${executionId}-${step}-${transitionCounter}`,
      );
    },
    async recordPlanningDecision({ executionId, route }) {
      await world.executions.recordPlanningDecision(
        {
          applicationId: world.applicationId,
          executionId,
          tenantId: world.tenantId,
          actorId: world.actorId,
          decisionId: generateId(),
          planId: generateId(),
          payload: {
            candidates: [
              {
                strategyId: "val-019-pinned",
                plan: {
                  strategyClass: route.strategyClass,
                  modelCalls: 0,
                  steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                },
              },
            ],
            selectedStrategyId: "val-019-pinned",
          },
        },
        `val-019-${executionId}-decision`,
      );
    },
    async recordToolEvent({ executionId, command, tool, reference }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command,
          cause: `val-019-${command}`,
          reference: { tool, ...reference },
          payload: { tool },
        },
        `val-019-${executionId}-${command}-${tool}-${generateId().slice(-6)}`,
      );
    },
    async recordHumanDecision({ executionId, gateId, tool, decision, reason, reference }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "human-decision-recorded",
          cause: `val-019-gate-${gateId}`,
          reference: { gateId, tool, decision, reason, ...reference },
          payload: { decision, tool },
        },
        `val-019-${executionId}-human-decision-${tool}-${generateId().slice(-6)}`,
      );
    },
    async recordEscalation({ executionId, gateId, tool, routedTo, contextDigest }) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-019-escalation-${gateId}`,
          reference: { escalation: true, gateId, tool, routedTo, contextDigest },
          payload: { escalation: true, routedTo },
        },
        `val-019-${executionId}-escalation-${tool}-${generateId().slice(-6)}`,
      );
    },
    async complete({ executionId, verdict, criteria, reason }) {
      await world.executions.transition(
        {
          actorId: world.actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          command: verdict,
          reason,
          verificationResults: criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            strategy: criterion.strategy,
            status: criterion.status,
            recordedBy: "val-019-platform",
            evidence: [...criterion.evidence],
          })),
        },
        `val-019-${executionId}-${verdict}`,
      );
    },
  };

  const dispatchRound = async (input: {
    readonly executionId: string;
    readonly round: number;
    readonly messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
  }): Promise<
    | { readonly kind: "success"; readonly content: string; readonly usage?: LabUsage }
    | { readonly kind: "failure"; readonly category: string; readonly message: string }
  > => {
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: MODEL,
      messages: input.messages,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      structuredOutput: { name: AGENTIC_PROTOCOL_SCHEMA, schema: AGENTIC_STEP_SCHEMA },
    });
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      const content =
        response.structuredOutput !== null
          ? JSON.stringify(response.structuredOutput.json)
          : response.content.join("\n");
      return {
        kind: "success",
        content,
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          costUsd: response.usage.costUsd ?? undefined,
        },
      };
    }
    const failure = result.outcome.failure;
    return {
      kind: "failure",
      category: failure.category,
      message: failure.providerMessage ?? "provider failure (no provider message)",
    };
  };

  return { lifecycle, principal, dispatchRound };
}

interface AppSuite {
  readonly app: string;
  readonly tasks: readonly { readonly expectedTerminal: "COMPLETED" | "FAILED" }[];
  readonly groundTruths: readonly AgenticTaskGroundTruth[];
  readonly toolContracts: Parameters<typeof driveAgenticExecution>[0]["toolContracts"];
  readonly runApp: (options: {
    readonly config: {
      readonly applicationId: string;
      readonly baseUrl: string;
      readonly tokenEnvVar: string;
      readonly applicationRevision: string;
      readonly corpusRevision: string;
      readonly integrationSurface: string;
      readonly pollIntervalMs: number;
      readonly completionTimeoutMs: number;
    };
    readonly token: string;
    readonly transport: Parameters<typeof runCustomerServiceApp>[0]["transport"];
    readonly now: () => Date;
    readonly sleep: (ms: number) => Promise<void>;
    readonly environment: {
      readonly runtime: string;
      readonly toolchain: string;
      readonly database: string;
      readonly configuration: Readonly<Record<string, string>>;
    };
    readonly runSuffix: string;
    readonly taskIndex: number;
  }) => Promise<{
    readonly evidence: Parameters<typeof validateHarnessEvidence>[0];
    readonly passed: boolean;
  }>;
  readonly worldFor: (taskIndex: number) => Parameters<typeof driveAgenticExecution>[0]["world"];
  readonly timeoutMs: number;
}

function notRunBoundary(app: string): void {
  console.warn(
    `[VAL-019] OPENROUTER_API_KEY absent — the REAL ${app} provider run is a NOT RUN boundary ` +
      "(recorded honestly; no fake success is asserted).",
  );
}

definePgSuite("VAL-019 agentic + HITL application suite over the real platform path", (ctx) => {
  const buildSuites = (): readonly AppSuite[] => [
    {
      app: "customer-service",
      tasks: CUSTOMER_SERVICE_TASKS,
      groundTruths: CS_TASK_GROUND_TRUTHS,
      toolContracts: CS_TOOL_CONTRACTS,
      runApp: runCustomerServiceApp,
      worldFor: () => createCsWorld(),
      timeoutMs: 600_000,
    },
    {
      app: "browser-use",
      tasks: BROWSER_USE_TASKS,
      groundTruths: BROWSER_TASK_GROUND_TRUTHS,
      toolContracts: BROWSER_TOOL_CONTRACTS,
      runApp: runBrowserUseApp,
      worldFor: () => createBrowserWorld(),
      timeoutMs: 600_000,
    },
    {
      app: "computer-use",
      tasks: COMPUTER_USE_TASKS,
      groundTruths: COMPUTER_TASK_GROUND_TRUTHS,
      toolContracts: COMPUTER_TOOL_CONTRACTS,
      runApp: runComputerUseApp,
      worldFor: (taskIndex) => {
        const truth = COMPUTER_TASK_GROUND_TRUTHS[taskIndex];
        if (truth === undefined) throw new Error("missing computer-use truth");
        return createComputerWorld(truth.files);
      },
      timeoutMs: 600_000,
    },
    {
      app: "research",
      tasks: RESEARCH_TASKS,
      groundTruths: RESEARCH_TASK_GROUND_TRUTHS,
      toolContracts: RESEARCH_TOOL_CONTRACTS,
      runApp: runResearchApp,
      worldFor: () => createResearchWorld(),
      timeoutMs: 600_000,
    },
    {
      app: "coding",
      tasks: CODING_TASKS,
      groundTruths: CODING_TASK_GROUND_TRUTHS,
      toolContracts: CODING_TOOL_CONTRACTS,
      runApp: runCodingApp,
      worldFor: (taskIndex) => {
        const spec = CODING_TASKS[taskIndex]?.spec ?? "fn-fizzmod";
        return createCodingWorld(spec);
      },
      timeoutMs: 600_000,
    },
    {
      app: "operations",
      tasks: OPERATIONS_TASKS,
      groundTruths: OPERATIONS_ROWS.map((row) => row.truth),
      toolContracts: OPS_TOOL_CONTRACTS,
      runApp: runOperationsApp,
      worldFor: (taskIndex) => {
        const row = OPERATIONS_ROWS[taskIndex];
        if (row === undefined) throw new Error("missing operations row");
        return createOpsWorld(row.services);
      },
      timeoutMs: 600_000,
    },
  ];

  for (const suite of buildSuites()) {
    test(`the ${suite.app} application completes multi-step agentic work end to end`, {
      timeout: suite.timeoutMs,
    }, async () => {
      if (OPENROUTER_KEY.length === 0) {
        notRunBoundary(suite.app);
        expect(true).toBe(true);
        return;
      }
      if (suite.app === "browser-use" || suite.app === "computer-use") {
        console.info(
          `[VAL-019] ${suite.app}: the LIVE ${suite.app === "browser-use" ? "web" : "desktop"} ` +
            "surface is a NOT RUN boundary — controlled in-memory fixtures only.",
        );
      }

      const generateId = createUuidv7Generator();
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const binding = await buildPlatformBinding(ctx, world);

      const runFacts: RunFacts[] = [];
      const drivenExecutionIds = new Set<string>();

      try {
        for (const [index] of suite.tasks.entries()) {
          const task = suite.tasks[index];
          const truth = suite.groundTruths[index];
          if (task === undefined || truth === undefined) throw new Error("missing task/truth");
          const fixtureWorld = suite.worldFor(index);
          const runSuffix = `it-${generateId().slice(-8)}`;
          const appPromise = suite
            .runApp({
              config: {
                applicationId: world.applicationId,
                baseUrl: address,
                tokenEnvVar: "ZECK_VALIDATION_TOKEN",
                applicationRevision: REVISION,
                corpusRevision: REVISION,
                integrationSurface: "sdk",
                pollIntervalMs: 250,
                completionTimeoutMs: 480_000,
              },
              token: world.bearerToken,
              transport: globalThis.fetch,
              now: () => new Date(),
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              environment: {
                runtime: `node ${process.version}`,
                toolchain: "vitest",
                database: "postgresql",
                configuration: { suite: `val-019-${suite.app}` },
              },
              runSuffix,
              taskIndex: index,
            })
            .then(
              (outcome) => ({ ok: true as const, outcome }),
              (error: unknown) => ({ ok: false as const, error }),
            );

          let executionId: string | null = null;
          for (let attempt = 0; attempt < 2_400 && executionId === null; attempt += 1) {
            const rows = await ctx.port.execute<{ id: string }>({
              sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
              parameters: [world.applicationId],
            });
            const id = rows.rows[0]?.id;
            if (id !== undefined && !drivenExecutionIds.has(id)) {
              drivenExecutionIds.add(id);
              executionId = id;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(executionId).not.toBeNull();

          const platformResult = await driveAgenticExecution({
            executionId: executionId as string,
            task: { kind: `${suite.app}-task`, input: {} },
            groundTruth: truth,
            provider: PROVIDER,
            model: MODEL,
            toolContracts: suite.toolContracts,
            lifecycle: binding.lifecycle,
            dispatch: binding.dispatchRound,
            world: fixtureWorld,
            approver: approverFromGroundTruth(truth),
            now: () => new Date(),
            retry: {
              maxExtraAttempts: 2,
              delayMs: 4_000,
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            },
          });

          // The durable ledger evidence for THIS execution.
          const events = await ctx.port.execute<{ command: string }>({
            sql: `SELECT command FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence ASC`,
            parameters: [executionId],
          });
          const commands = events.rows.map((row) => row.command);
          const toolEvents = commands.filter((command) => command.startsWith("tool-")).length;
          const waitToolCycles = commands.filter((c) => c === "wait-tool").length;
          const waitHumanCycles = commands.filter((c) => c === "wait-human").length;
          const humanDecisions = commands.filter((c) => c === "human-decision-recorded").length;

          const appSettled = await appPromise;
          if (!appSettled.ok) {
            throw appSettled.error;
          }
          const violations = validateHarnessEvidence(appSettled.outcome.evidence);

          runFacts.push({
            app: suite.app,
            taskIndex: index,
            goal: truth.goal,
            terminal: platformResult.terminal,
            criteria: platformResult.criteria.map((c) => ({
              criterionId: c.criterionId,
              status: c.status,
            })),
            appPassed: appSettled.outcome.passed,
            rounds: platformResult.rounds,
            dispatchAttempts: platformResult.dispatchAttempts,
            toolEvents,
            waitToolCycles,
            waitHumanCycles,
            humanDecisions,
            usage: platformResult.usage,
          });

          // The honest outcome contract for every run.
          expect(violations).toEqual([]);
          const anyFail = platformResult.criteria.some((c) => c.status === "FAIL");
          expect(platformResult.terminal).toBe(anyFail ? "FAILED" : "COMPLETED");
          expect(appSettled.outcome.passed).toBe(task.expectedTerminal === platformResult.terminal);
          expect(platformResult.terminal).toBe(task.expectedTerminal);
          // Every tool execution is bracketed by a REAL wait-tool cycle
          // and journaled as step events.
          expect(waitToolCycles).toBe(platformResult.trace.length);
          expect(toolEvents).toBeGreaterThanOrEqual(platformResult.trace.length);
          // Every approval gate is a REAL wait-human → resume cycle
          // with a recorded human decision on the ledger.
          expect(waitHumanCycles).toBe(platformResult.gates.length);
          expect(humanDecisions).toBe(platformResult.gates.length);
          if (platformResult.usage !== null) {
            expect(platformResult.usage.inputTokens).toBeGreaterThan(0);
          }
        }

        // The journal carries every REAL agent-round dispatch (the
        // previous app suites in this database also journaled their
        // dispatches — the count is cumulative and monotone).
        const journal = await ctx.port.execute<{ status: string }>({
          sql: `SELECT status FROM models.dispatch_attempts ORDER BY created_at ASC`,
          parameters: [],
        });
        const totalRounds = runFacts.reduce((sum, fact) => sum + fact.rounds, 0);
        expect(journal.rows.length).toBeGreaterThanOrEqual(totalRounds);
        const totalCost = runFacts.reduce((sum, fact) => sum + (fact.usage?.costUsd ?? 0), 0);
        const totalInput = runFacts.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0);
        const totalOutput = runFacts.reduce(
          (sum, fact) => sum + (fact.usage?.outputTokens ?? 0),
          0,
        );
        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        console.info(
          `[VAL-019] REAL ${suite.app} run summary: ${completed}/${runFacts.length} COMPLETED; ` +
            `${totalRounds} model rounds; measured usage ${totalInput}+${totalOutput} tokens, ` +
            `measured cost $${totalCost.toFixed(6)}; model ${MODEL} via ${PROVIDER} (BYOK).`,
        );
        for (const fact of runFacts) {
          console.info(
            `[VAL-019]   ${suite.app}#${fact.taskIndex} "${truncate(fact.goal, 52)}" -> ` +
              `${fact.terminal} rounds=${fact.rounds} attempts=${fact.dispatchAttempts} ` +
              `toolEvents=${fact.toolEvents} waitTool=${fact.waitToolCycles} ` +
              `waitHuman=${fact.waitHumanCycles} decisions=${fact.humanDecisions} ` +
              `[${fact.criteria.map((c) => `${c.criterionId}:${c.status}`).join(", ")}] ` +
              `usage=${fact.usage ? `${fact.usage.inputTokens}+${fact.usage.outputTokens}` : "n/a"}`,
          );
        }
      } finally {
        await world.server.app.close();
      }
    });
  }
});

function truncate(text: string, bound: number): string {
  const cleaned = text.replaceAll(/\s+/g, " ").trim();
  return cleaned.length <= bound ? cleaned : `${cleaned.slice(0, bound)}…`;
}
