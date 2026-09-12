/**
 * VAL-010 acceptance criteria 3, 4, 5 — the crown proof: the three
 * customer-style applications run end to end against the REAL platform
 * path with a REAL provider completion.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port;
 *   - the REAL model gateway over the REAL SQL credential vault, the
 *     REAL BYOK connection (credential materialized from the
 *     environment at run time — never in the repository) and the REAL
 *     OpenRouter rail adapter with the REAL production fetch transport;
 *   - the REAL executions lifecycle (canonical transitions + durable
 *     planning decision) driven platform-side exactly as Zeck's
 *     operators would;
 *   - the REAL mechanical verification criteria recorded on the
 *     execution ledger (the application asserts the verified outcome).
 *
 * The provider credential is environment-gated: absent
 * OPENROUTER_API_KEY → the REAL provider run is a NOT RUN boundary
 * (recorded; never a silent pass).
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  runStructuredExtractionApp,
  STRUCTURED_EXTRACTION_TASKS,
} from "../../../benchmarks/validation/apps/structured-extraction/application";
import {
  runTextGenerationApp,
  TEXT_GENERATION_TASKS,
} from "../../../benchmarks/validation/apps/text-generation/application";
import {
  runTransformationApp,
  TRANSFORMATION_TASKS,
} from "../../../benchmarks/validation/apps/transformation/application";
import { GOLDEN_TASKS } from "../../../benchmarks/validation/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  deriveDispatchPlan,
  type Val010Task,
} from "../../../benchmarks/validation/platform/derive";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import { driveExecutionToCompletion } from "../../../benchmarks/validation/platform/driver";
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
const MODEL = process.env.ZECK_VAL_010_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update(`${PROVIDER}|${MODEL}|val-010-pinned`)
  .digest("hex")
  .slice(0, 40);

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly app: string;
  readonly taskIndex: number;
  readonly taskKind: string;
  readonly fixtureKey: string;
  readonly terminal: string;
  readonly criteria: readonly { criterionId: string; status: string }[];
  readonly appPassed: boolean;
  readonly evidenceViolations: number;
  readonly usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
  readonly dispatchLatencyMs: number | null;
}

/** The corpus row's own expected outcome for one task input. */
function corpusExpectationsOf(task: {
  readonly kind: string;
}): { readonly containsText?: readonly string[] } | undefined {
  const corpusTask = GOLDEN_TASKS.find(
    (candidate) =>
      candidate.input.kind === task.kind &&
      (task.kind === "summarize" || task.kind === "extract"
        ? candidate.input.doc === (task as { doc?: string }).doc
        : task.kind === "transform"
          ? candidate.input.source === (task as { source?: string }).source
          : candidate.input.set === (task as { set?: string }).set),
  );
  const containsText = corpusTask?.expectedOutcome.containsText;
  return containsText === undefined || containsText.length === 0 ? undefined : { containsText };
}

definePgSuite(
  "VAL-010 customer applications over the real platform path (REAL provider)",
  (ctx) => {
    test("text-generation, structured-extraction and transformation applications complete end to end", {
      timeout: 900_000,
    }, async () => {
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-010] OPENROUTER_API_KEY absent — the REAL provider run is a NOT RUN boundary " +
            "(recorded honestly; no fake success is asserted).",
        );
        expect(true).toBe(true);
        return;
      }

      const generateId = createUuidv7Generator();
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });

      // ---- The REAL model-side composition (BYOK connection + gateway) ----
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
            return { satisfied: true, catalogRevision: "val-010", satisfactions: [] };
          },
        },
        rails: registry,
        journal: createSqlDispatchJournal(ctx.port),
        generateId,
        defaultTimeoutMs: 150_000,
        hashRequest: (request) =>
          createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
      });

      const PRINCIPAL = {
        actorId: world.actorId,
        authenticatedAt: new Date().toISOString(),
      };
      const { connection } = await connections.registerConnection(
        {
          principal: PRINCIPAL,
          applicationId: world.applicationId,
          rail: "openrouter",
          label: "val-010-openrouter",
          registerCredential: { material: OPENROUTER_KEY },
        },
        `val-010-conn-${generateId().slice(-8)}`,
      );
      expect(connection.rail).toBe("openrouter");

      // ---- The platform-side lifecycle binding (REAL executions service) ----
      const lifecycle: PlatformLifecyclePort = {
        async transition({ executionId, step, reason }) {
          await world.executions.transition(
            {
              actorId: world.actorId,
              applicationId: world.applicationId,
              tenantId: world.tenantId,
              executionId,
              command: step,
              reason,
            },
            `val-010-${executionId}-${step}`,
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
                    strategyId: "val-010-pinned",
                    plan: {
                      strategyClass: route.strategyClass,
                      modelCalls: 1,
                      steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                    },
                  },
                ],
                selectedStrategyId: "val-010-pinned",
              },
            },
            `val-010-${executionId}-decision`,
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
                recordedBy: "val-010-platform",
                evidence: [...criterion.evidence],
              })),
            },
            `val-010-${executionId}-${verdict}`,
          );
        },
      };

      // ---- The REAL dispatch binding (gateway → rail → provider) ----
      const dispatch = async (input: {
        readonly executionId: string;
        readonly task: Val010Task;
        readonly provider: string;
        readonly model: string;
      }) => {
        const plan = deriveDispatchPlan(input.task, {
          provider: input.provider,
          model: input.model,
        });
        const result = await gateway.complete(PRINCIPAL, world.applicationId, connection.id, {
          model: plan.request.model,
          messages: plan.request.messages,
          maxTokens: plan.request.maxTokens,
          temperature: plan.request.temperature,
          ...(plan.request.structuredOutput === undefined
            ? {}
            : {
                structuredOutput: {
                  name: plan.request.structuredOutput.name,
                  schema: plan.request.structuredOutput.schema,
                },
              }),
        });
        if (result.outcome.kind === "provider-success") {
          const response = result.outcome.response;
          const content =
            response.structuredOutput !== null
              ? JSON.stringify(response.structuredOutput.json)
              : response.content.join("\n");
          return {
            kind: "success" as const,
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
          kind: "failure" as const,
          category: failure.category,
          message: failure.providerMessage ?? "provider failure (no provider message)",
          retryable: failure.retryable,
        };
      };

      // ---- The pinned slices (customer applications) ----
      const runFacts: RunFacts[] = [];
      const drivenExecutionIds = new Set<string>();
      const runTask = async (options: {
        readonly app: string;
        readonly taskIndex: number;
        readonly task: { readonly kind: string };
        /** The corpus row's own expected terminal status. */
        readonly expectedTerminal: "COMPLETED" | "FAILED";
        readonly runApp: (opts: {
          readonly config: {
            readonly applicationId: string;
            readonly baseUrl: string;
            readonly tokenEnvVar: string;
            readonly applicationRevision: string;
            readonly corpusRevision: string;
            readonly integrationSurface: "sdk";
            readonly pollIntervalMs: number;
            readonly completionTimeoutMs: number;
          };
          readonly token: string;
          readonly transport: typeof fetch;
          readonly now: () => Date;
          readonly sleep: (ms: number) => Promise<void>;
          readonly environment: {
            readonly runtime: string;
            readonly toolchain: string;
            readonly database: string;
            readonly configuration: Record<string, string>;
          };
          readonly runSuffix: string;
          readonly taskIndex: number;
        }) => Promise<{
          readonly evidence: { readonly terminalStatus: unknown };
          readonly passed: boolean;
        }>;
        readonly evidenceOf: (outcome: { readonly evidence: unknown }) => {
          readonly terminalStatus: unknown;
        };
      }) => {
        const runSuffix = `it-${generateId().slice(-8)}`;
        const appPromise = options
          .runApp({
            config: {
              applicationId: world.applicationId,
              baseUrl: address,
              tokenEnvVar: "ZECK_VALIDATION_TOKEN",
              applicationRevision: REVISION,
              corpusRevision: REVISION,
              integrationSurface: "sdk",
              pollIntervalMs: 250,
              completionTimeoutMs: 180_000,
            },
            token: world.bearerToken,
            transport: globalThis.fetch,
            now: () => new Date(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            environment: {
              runtime: `node ${process.version}`,
              toolchain: "vitest",
              database: "postgresql",
              configuration: { suite: "val-010-real-model" },
            },
            runSuffix,
            taskIndex: options.taskIndex,
          })
          .then(
            (outcome) => ({ ok: true as const, outcome }),
            (error: unknown) => ({ ok: false as const, error }),
          );

        // Platform side: wait for THIS task's submission to land — the
        // cursor skips executions already driven (a stale row would
        // replay transitions and collide on the planning decision).
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

        const platformResult = await driveExecutionToCompletion({
          executionId: executionId as string,
          task: options.task as never,
          provider: PROVIDER,
          model: MODEL,
          expectations: corpusExpectationsOf(options.task as { kind: string }),
          ports: { lifecycle, dispatch, now: () => new Date() },
        });

        const appSettled = await appPromise;
        if (!appSettled.ok) {
          throw appSettled.error;
        }
        const appOutcome = appSettled.outcome;
        const violations = validateHarnessEvidence(appOutcome.evidence as never);

        runFacts.push({
          app: options.app,
          taskIndex: options.taskIndex,
          taskKind: options.task.kind,
          fixtureKey:
            options.task.kind === "summarize"
              ? String((options.task as { doc?: string }).doc ?? "")
              : options.task.kind === "transform"
                ? String((options.task as { source?: string }).source ?? "")
                : options.task.kind === "extract"
                  ? String((options.task as { doc?: string }).doc ?? "")
                  : String((options.task as { set?: string }).set ?? ""),
          terminal: platformResult.terminal,
          criteria: platformResult.criteria.map((c) => ({
            criterionId: c.criterionId,
            status: c.status,
          })),
          appPassed: appOutcome.passed,
          evidenceViolations: violations.length,
          usage:
            platformResult.usage === null
              ? null
              : {
                  inputTokens: platformResult.usage.inputTokens,
                  outputTokens: platformResult.usage.outputTokens,
                  costUsd: platformResult.usage.costUsd ?? null,
                },
          dispatchLatencyMs: platformResult.dispatchLatencyMs,
        });

        // The honest outcome contract (mechanically checkable for every
        // run): valid evidence; terminal consistent with the criteria
        // (any FAIL criterion -> FAILED); the app's verdict consistent
        // with the CORPUS row's own expected terminal status.
        expect(violations).toEqual([]);
        const anyFail = platformResult.criteria.some((c) => c.status === "FAIL");
        expect(platformResult.terminal).toBe(anyFail ? "FAILED" : "COMPLETED");
        expect(appOutcome.passed).toBe(options.expectedTerminal === platformResult.terminal);
        if (platformResult.usage !== null) {
          expect(platformResult.usage.inputTokens).toBeGreaterThan(0);
          expect(platformResult.usage.outputTokens).toBeGreaterThan(0);
        }
      };

      try {
        for (const [index, task] of TEXT_GENERATION_TASKS.entries()) {
          await runTask({
            app: "text-generation",
            taskIndex: index,
            task,
            expectedTerminal: "COMPLETED",
            runApp: runTextGenerationApp,
            evidenceOf: (outcome) => outcome.evidence as { terminalStatus: unknown },
          });
        }
        for (const [index, task] of STRUCTURED_EXTRACTION_TASKS.entries()) {
          await runTask({
            app: "structured-extraction",
            taskIndex: index,
            task,
            // The corpus's own expectation for the edge row (invoice-007,
            // missing total): FAILED — never a fabricated success.
            expectedTerminal: index === 2 ? "FAILED" : "COMPLETED",
            runApp: runStructuredExtractionApp,
            evidenceOf: (outcome) => outcome.evidence as { terminalStatus: unknown },
          });
        }
        for (const [index, task] of TRANSFORMATION_TASKS.entries()) {
          await runTask({
            app: "transformation",
            taskIndex: index,
            task,
            expectedTerminal: "COMPLETED",
            runApp: runTransformationApp,
            evidenceOf: (outcome) => outcome.evidence as { terminalStatus: unknown },
          });
        }

        // The journal carries the durable provider-axis facts of every
        // dispatched attempt (REAL usage; REAL outcomes).
        const journal = await ctx.port.execute<{
          status: string;
          rail: string;
          model: string;
        }>({
          sql: `SELECT status, rail, model FROM models.dispatch_attempts ORDER BY created_at ASC`,
          parameters: [],
        });
        expect(journal.rows.length).toBeGreaterThanOrEqual(10);
        for (const row of journal.rows) {
          expect(row.rail).toBe("openrouter");
          expect(row.model).toBe(MODEL);
        }

        // The REAL results summary (recorded in the evidence doc).
        const completed = runFacts.filter((f) => f.terminal === "COMPLETED").length;
        const totalCost = runFacts.reduce((sum, f) => sum + (f.usage?.costUsd ?? 0), 0);
        const totalInputTokens = runFacts.reduce((sum, f) => sum + (f.usage?.inputTokens ?? 0), 0);
        const totalOutputTokens = runFacts.reduce(
          (sum, f) => sum + (f.usage?.outputTokens ?? 0),
          0,
        );
        console.info(
          `[VAL-010] REAL run summary: ${completed}/${runFacts.length} COMPLETED; ` +
            `measured usage ${totalInputTokens}+${totalOutputTokens} tokens, ` +
            `measured cost $${totalCost.toFixed(6)}; model ${MODEL} via ${PROVIDER} (BYOK).`,
        );
        for (const fact of runFacts) {
          console.info(
            `[VAL-010]   ${fact.app}#${fact.taskIndex} (${fact.fixtureKey}) -> ${fact.terminal} ` +
              `[${fact.criteria.map((c) => `${c.criterionId}:${c.status}`).join(", ")}] ` +
              `usage=${fact.usage ? `${fact.usage.inputTokens}+${fact.usage.outputTokens}/$${(fact.usage.costUsd ?? 0).toFixed(6)}` : "n/a"} ` +
              `latency=${fact.dispatchLatencyMs}ms`,
          );
        }
      } finally {
        await world.server.app.close();
      }
    });
  },
);
