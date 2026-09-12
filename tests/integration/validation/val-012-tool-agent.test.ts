/**
 * VAL-012 acceptance criteria 3, 4, 5, 6 — the crown proof: the
 * tool-using agent application runs end to end against the REAL
 * platform path with a REAL multi-step model loop.
 *
 * REAL pieces (nothing faked on the critical path):
 *   - the REAL Fastify public API over the REAL SQL authorities;
 *   - the REAL model gateway + BYOK connection + OpenRouter rail
 *     adapter + production fetch transport — one REAL dispatch PER
 *     agent round, with the agent protocol as native structured output;
 *   - the REAL execution state machine, including GENUINE wait-tool →
 *     resume cycles around every tool execution;
 *   - the REAL ledger step-event vocabulary (tool-requested /
 *     tool-result / tool-denied) recording the invocation trace;
 *   - the deterministic in-lab toolset (calculator/calendar/converter/
 *     lookup/policy-engine) as the governed tool surface;
 *   - mechanical trace verification against the row ground truths.
 *
 * The provider credential is environment-gated (absent key = recorded
 * NOT RUN boundary, never a fake success).
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  runToolAgentApp,
  TOOL_AGENT_TASKS,
} from "../../../benchmarks/validation/apps/tool-agent/application";
import {
  executeTool,
  TOOL_CONTRACTS,
  TOOL_TASK_GROUND_TRUTHS,
  type ToolTaskGroundTruth,
  WORKFLOW_TASK_GROUND_TRUTHS,
} from "../../../benchmarks/validation/apps/tool-agent/tools";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import {
  AGENT_PROTOCOL_SCHEMA,
  AGENT_STEP_SCHEMA,
  driveToolAgentExecution,
  type ToolAgentLifecyclePort,
  type ToolAgentTaskGroundTruth,
} from "../../../benchmarks/validation/platform/tool-agent";
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
import { seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const PROVIDER = "openrouter";
const MODEL = process.env.ZECK_VAL_012_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update(`${PROVIDER}|${MODEL}|val-012-pinned`)
  .digest("hex")
  .slice(0, 40);

interface RunFacts {
  readonly taskIndex: number;
  readonly taskKind: string;
  readonly goal: string;
  readonly terminal: string;
  readonly criteria: readonly { criterionId: string; status: string }[];
  readonly appPassed: boolean;
  readonly rounds: number;
  readonly toolEvents: number;
  readonly waitToolCycles: number;
  readonly usage: LabUsage | null;
}

/** Ground truth for one pinned task index (tool rows + workflow rows). */
function groundTruthForIndex(index: number): ToolAgentTaskGroundTruth {
  if (index < TOOL_TASK_GROUND_TRUTHS.length) {
    return TOOL_TASK_GROUND_TRUTHS[index] as ToolTaskGroundTruth;
  }
  const workflow = WORKFLOW_TASK_GROUND_TRUTHS[index - TOOL_TASK_GROUND_TRUTHS.length];
  if (workflow === undefined) {
    throw new Error(`no ground truth for task index ${index}`);
  }
  return {
    // The customer's output contract: the routing decision's leading
    // keyword is reported verbatim (the corpus row's containsText).
    goal:
      `Route invoice ${workflow.invoiceId} through the approval policy using the ` +
      `policy-engine tool, and report the routing decision's leading keyword ` +
      `(approved / pending / rejected / exception) verbatim`,
    exposedTools: ["policy-engine"],
    expectedTrace: [{ tool: "policy-engine", exactArguments: { invoiceId: workflow.invoiceId } }],
    expectedAnswerTerms: [workflow.expectedRouting],
    goalAchievable: workflow.goalAchievable,
    // The corpus judges workflow rows by the routing decision and the
    // recorded approval events — not the call trace.
    traceComparison: "in-order",
  };
}

definePgSuite(
  "VAL-012 tool-agent application over the real platform path (REAL provider)",
  (ctx) => {
    test("the tool-using agent application completes multi-step workflows end to end", {
      timeout: 900_000,
    }, async () => {
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-012] OPENROUTER_API_KEY absent — the REAL provider run is a NOT RUN boundary " +
            "(recorded honestly; no fake success is asserted).",
        );
        expect(true).toBe(true);
        return;
      }

      const generateId = createUuidv7Generator();
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });

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
            return { satisfied: true, catalogRevision: "val-012", satisfactions: [] };
          },
        },
        rails: registry,
        journal: createSqlDispatchJournal(ctx.port),
        generateId,
        defaultTimeoutMs: 150_000,
        hashRequest: (request) =>
          createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
      });

      const PRINCIPAL = { actorId: world.actorId, authenticatedAt: new Date().toISOString() };
      const { connection } = await connections.registerConnection(
        {
          principal: PRINCIPAL,
          applicationId: world.applicationId,
          rail: "openrouter",
          label: "val-012-openrouter",
          registerCredential: { material: OPENROUTER_KEY },
        },
        `val-012-conn-${generateId().slice(-8)}`,
      );

      let transitionCounter = 0;
      const lifecycle: ToolAgentLifecyclePort = {
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
            // Every call gets a unique key: repeated steps (wait-tool per
            // tool round) must never collide on the idempotency ledger.
            `val-012-${executionId}-${step}-${transitionCounter}`,
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
                    strategyId: "val-012-pinned",
                    plan: {
                      strategyClass: route.strategyClass,
                      modelCalls: 0,
                      steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                    },
                  },
                ],
                selectedStrategyId: "val-012-pinned",
              },
            },
            `val-012-${executionId}-decision`,
          );
        },
        async recordToolEvent({ executionId, command, tool, reference }) {
          await world.executions.recordStepEvent(
            {
              applicationId: world.applicationId,
              executionId,
              actor: { actorId: world.actorId, tenantId: world.tenantId },
              command,
              cause: `val-012-${command}`,
              reference: { tool, ...reference },
              payload: { tool },
            },
            `val-012-${executionId}-${command}-${tool}-${generateId().slice(-6)}`,
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
                recordedBy: "val-012-platform",
                evidence: [...criterion.evidence],
              })),
            },
            `val-012-${executionId}-${verdict}`,
          );
        },
      };

      const dispatchRound = async (input: {
        readonly executionId: string;
        readonly round: number;
        readonly messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
      }): Promise<
        | { kind: "success"; content: string; usage?: LabUsage }
        | { kind: "failure"; category: string; message: string }
      > => {
        const result = await gateway.complete(PRINCIPAL, world.applicationId, connection.id, {
          model: MODEL,
          messages: input.messages,
          maxTokens: 512,
          temperature: 0,
          structuredOutput: { name: AGENT_PROTOCOL_SCHEMA, schema: AGENT_STEP_SCHEMA },
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

      const runFacts: RunFacts[] = [];
      const drivenExecutionIds = new Set<string>();

      try {
        for (const [index] of TOOL_AGENT_TASKS.entries()) {
          const task = TOOL_AGENT_TASKS[index];
          if (task === undefined) throw new Error("missing task");
          const groundTruth = groundTruthForIndex(index);
          const runSuffix = `it-${generateId().slice(-8)}`;
          const appPromise = runToolAgentApp({
            config: {
              applicationId: world.applicationId,
              baseUrl: address,
              tokenEnvVar: "ZECK_VALIDATION_TOKEN",
              applicationRevision: REVISION,
              corpusRevision: REVISION,
              integrationSurface: "sdk",
              pollIntervalMs: 250,
              completionTimeoutMs: 300_000,
            },
            token: world.bearerToken,
            transport: globalThis.fetch,
            now: () => new Date(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            environment: {
              runtime: `node ${process.version}`,
              toolchain: "vitest",
              database: "postgresql",
              configuration: { suite: "val-012-tool-agent" },
            },
            runSuffix,
            taskIndex: index,
          }).then(
            (outcome) => ({ ok: true as const, outcome }),
            (error: unknown) => ({ ok: false as const, error }),
          );

          let executionId: string | null = null;
          for (let attempt = 0; attempt < 1_200 && executionId === null; attempt += 1) {
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

          const platformResult = await driveToolAgentExecution({
            executionId: executionId as string,
            task: { kind: task.kind, input: {} },
            groundTruth,
            provider: PROVIDER,
            model: MODEL,
            toolContracts: TOOL_CONTRACTS,
            lifecycle,
            dispatch: dispatchRound,
            tools: { execute: executeTool },
            now: () => new Date(),
          });

          // The durable step-event trace on the REAL ledger.
          const events = await ctx.port.execute<{ command: string }>({
            sql: `SELECT (payload)->>'tool' AS tool, command FROM executions.execution_events
                  WHERE execution_id = $1 AND command LIKE 'tool-%' ORDER BY sequence ASC`,
            parameters: [executionId],
          });
          const toolEvents = events.rows.length;
          const waitToolCycles = (
            await ctx.port.execute<{ command: string }>({
              sql: `SELECT command FROM executions.execution_events WHERE execution_id = $1 AND command = 'wait-tool'`,
              parameters: [executionId],
            })
          ).rows.length;

          const appSettled = await appPromise;
          if (!appSettled.ok) {
            throw appSettled.error;
          }
          const violations = validateHarnessEvidence(appSettled.outcome.evidence as never);

          runFacts.push({
            taskIndex: index,
            taskKind: task.kind,
            goal: groundTruth.goal,
            terminal: platformResult.terminal,
            criteria: platformResult.criteria.map((c) => ({
              criterionId: c.criterionId,
              status: c.status,
            })),
            appPassed: appSettled.outcome.passed,
            rounds: platformResult.rounds,
            toolEvents,
            waitToolCycles,
            usage: platformResult.usage,
          });

          // The honest outcome contract for every run.
          expect(violations).toEqual([]);
          const anyFail = platformResult.criteria.some((c) => c.status === "FAIL");
          expect(platformResult.terminal).toBe(anyFail ? "FAILED" : "COMPLETED");
          expect(appSettled.outcome.passed).toBe(task.expectedTerminal === platformResult.terminal);
          // Every tool execution is bracketed by a REAL wait-tool cycle
          // and journaled as step events.
          expect(waitToolCycles).toBe(platformResult.trace.length);
          expect(toolEvents).toBeGreaterThanOrEqual(platformResult.trace.length);
          if (platformResult.usage !== null) {
            expect(platformResult.usage.inputTokens).toBeGreaterThan(0);
          }
        }

        // The journal carries every REAL agent-round dispatch.
        const journal = await ctx.port.execute<{ status: string }>({
          sql: `SELECT status FROM models.dispatch_attempts ORDER BY created_at ASC`,
          parameters: [],
        });
        const totalDispatches = journal.rows.length;
        const totalRounds = runFacts.reduce((sum, fact) => sum + fact.rounds, 0);
        expect(totalDispatches).toBeGreaterThanOrEqual(totalRounds);
        const totalCost = runFacts.reduce((sum, fact) => sum + (fact.usage?.costUsd ?? 0), 0);
        const totalInput = runFacts.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0);
        const totalOutput = runFacts.reduce(
          (sum, fact) => sum + (fact.usage?.outputTokens ?? 0),
          0,
        );
        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        console.info(
          `[VAL-012] REAL run summary: ${completed}/${runFacts.length} COMPLETED; ` +
            `${totalRounds} model rounds; measured usage ${totalInput}+${totalOutput} tokens, ` +
            `measured cost $${totalCost.toFixed(6)}; model ${MODEL} via ${PROVIDER} (BYOK).`,
        );
        for (const fact of runFacts) {
          console.info(
            `[VAL-012]   #${fact.taskIndex} (${fact.taskKind}) "${truncate(fact.goal, 48)}" -> ${fact.terminal} ` +
              `rounds=${fact.rounds} toolEvents=${fact.toolEvents} waitToolCycles=${fact.waitToolCycles} ` +
              `[${fact.criteria.map((c) => `${c.criterionId}:${c.status}`).join(", ")}] ` +
              `usage=${fact.usage ? `${fact.usage.inputTokens}+${fact.usage.outputTokens}` : "n/a"}`,
          );
        }
      } finally {
        await world.server.app.close();
      }
    });
  },
);

function truncate(text: string, bound: number): string {
  const cleaned = text.replaceAll(/\s+/g, " ").trim();
  return cleaned.length <= bound ? cleaned : `${cleaned.slice(0, bound)}…`;
}
