/**
 * VAL-013 acceptance criteria 2, 3, 4, 5, 6 — the crown proof: the
 * long-running/resumable agent application runs end to end against the
 * REAL platform path.
 *
 * REAL pieces (nothing faked on the critical path): the REAL Fastify
 * public API over the REAL SQL authorities; the REAL execution state
 * machine (genuine wait-user → resume pairs; a REAL rejection of the
 * stale worker's invalid resume); the REAL ledger step-event vocabulary
 * (checkpoint-recorded / interruption-requested / resume-denied) with
 * digest-bearing checkpoints; the REAL model gateway + BYOK connection
 * + OpenRouter rail + production fetch transport for the supervisor
 * decisions; and the REAL idempotency ledger REPLAYING the no-op
 * resume after terminal.
 *
 * The provider credential is environment-gated (absent key = recorded
 * NOT RUN boundary, never a fake success).
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  expectedTerminalFor,
  runLongRunningApp,
} from "../../../benchmarks/validation/apps/long-running/application";
import {
  BATCH_JOBS,
  LONG_RUNNING_TASKS,
} from "../../../benchmarks/validation/apps/long-running/batch-jobs";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import {
  driveLongRunningExecution,
  type LongRunningLifecyclePort,
} from "../../../benchmarks/validation/platform/long-running";
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
import type { VerificationResultInput } from "../../../src/modules/executions/domain/verification";
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
const MODEL = process.env.ZECK_VAL_013_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update(`${PROVIDER}|${MODEL}|val-013-pinned`)
  .digest("hex")
  .slice(0, 40);

definePgSuite(
  "VAL-013 long-running application over the real platform path (REAL provider)",
  (ctx) => {
    test("the long-running/resumable agent application completes checkpointed executions end to end", {
      timeout: 900_000,
    }, async () => {
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-013] OPENROUTER_API_KEY absent — the REAL provider run is a NOT RUN boundary " +
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
            return { satisfied: true, catalogRevision: "val-013", satisfactions: [] };
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
          label: "val-013-openrouter",
          registerCredential: { material: OPENROUTER_KEY },
        },
        `val-013-conn-${generateId().slice(-8)}`,
      );

      let completeKeyOf: string | null = null;
      const toVerificationResults = (
        criteria: readonly {
          criterionId: string;
          strategy: "deterministic";
          status: "PASS" | "FAIL";
          evidence: readonly string[];
        }[],
      ): readonly VerificationResultInput[] =>
        criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          strategy: criterion.strategy,
          status: criterion.status,
          recordedBy: "val-013-platform",
          evidence: [...criterion.evidence],
        }));

      const lifecycle: LongRunningLifecyclePort = {
        async transition({ executionId, step, reason, callKey }) {
          await world.executions.transition(
            {
              actorId: world.actorId,
              applicationId: world.applicationId,
              tenantId: world.tenantId,
              executionId,
              command: step,
              reason,
            },
            `val-013-${executionId}-${step}-${callKey}`,
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
                    strategyId: "val-013-pinned",
                    plan: {
                      strategyClass: route.strategyClass,
                      modelCalls: 0,
                      steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                    },
                  },
                ],
                selectedStrategyId: "val-013-pinned",
              },
            },
            `val-013-${executionId}-decision`,
          );
        },
        async recordCheckpoint({ executionId, position, digest, callKey }) {
          await world.executions.recordStepEvent(
            {
              applicationId: world.applicationId,
              executionId,
              actor: { actorId: world.actorId, tenantId: world.tenantId },
              command: "checkpoint-recorded",
              cause: "val-013-checkpoint",
              reference: { position, digest },
              payload: { position, digest },
            },
            `val-013-${executionId}-checkpoint-${callKey}`,
          );
        },
        async recordInterruption({ executionId, at, callKey }) {
          await world.executions.recordStepEvent(
            {
              applicationId: world.applicationId,
              executionId,
              actor: { actorId: world.actorId, tenantId: world.tenantId },
              command: "interruption-requested",
              cause: "val-013-interruption",
              reference: { at },
              payload: { at },
            },
            `val-013-${executionId}-interruption-${callKey}`,
          );
        },
        async recordResumeDenied({ executionId, reason, callKey }) {
          await world.executions.recordStepEvent(
            {
              applicationId: world.applicationId,
              executionId,
              actor: { actorId: world.actorId, tenantId: world.tenantId },
              command: "resume-denied",
              cause: "val-013-resume-denied",
              reference: { reason },
              payload: { reason },
            },
            `val-013-${executionId}-resume-denied-${callKey}`,
          );
        },
        async complete(input) {
          completeKeyOf = `val-013-${input.executionId}-complete-${input.callKey}`;
          await world.executions.transition(
            {
              actorId: world.actorId,
              applicationId: world.applicationId,
              tenantId: world.tenantId,
              executionId: input.executionId,
              command: input.verdict,
              reason: input.reason,
              verificationResults: toVerificationResults(input.criteria),
            },
            completeKeyOf,
          );
        },
        async attemptNoOpResume(input) {
          // Re-issue the EXACT completion transition (same key, same
          // fingerprint): the platform's idempotency ledger must REPLAY
          // it — zero state change.
          const replayed = await world.executions.transition(
            {
              actorId: world.actorId,
              applicationId: world.applicationId,
              tenantId: world.tenantId,
              executionId: input.executionId,
              command: input.verdict,
              reason: input.reason,
              verificationResults: toVerificationResults(input.criteria),
            },
            completeKeyOf ?? `val-013-${input.executionId}-complete-unknown`,
          );
          return { replayed: replayed.replayed };
        },
      };

      const dispatchSupervisor = async (input: {
        readonly executionId: string;
        readonly segment: number;
        readonly progress: string;
      }): Promise<
        | { kind: "success"; content: string; usage?: LabUsage }
        | { kind: "failure"; category: string; message: string }
      > => {
        const result = await gateway.complete(PRINCIPAL, world.applicationId, connection.id, {
          model: MODEL,
          maxTokens: 64,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: [
                "You are the supervisor of a governed long-running batch execution.",
                "At each checkpoint you receive the committed progress and decide whether",
                "to continue. Answer with the single word: continue",
              ].join(" "),
            },
            {
              role: "user",
              content: `Segment ${input.segment}. Progress: ${input.progress}. Confirm continuation.`,
            },
          ],
        });
        if (result.outcome.kind === "provider-success") {
          return {
            kind: "success",
            content: result.outcome.response.content.join("\n"),
            usage: {
              inputTokens: result.outcome.response.usage.inputTokens,
              outputTokens: result.outcome.response.usage.outputTokens,
              costUsd: result.outcome.response.usage.costUsd ?? undefined,
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

      const runFacts: {
        readonly taskIndex: number;
        readonly jobId: string;
        readonly terminal: string;
        readonly criteria: readonly { criterionId: string; status: string }[];
        readonly appPassed: boolean;
        readonly segments: number;
        readonly checkpointEvents: number;
        readonly resumeDeniedEvents: number;
        readonly noOpResumeReplayed: boolean | null;
        readonly usage: LabUsage | null;
      }[] = [];
      const drivenExecutionIds = new Set<string>();

      try {
        for (const [index, task] of LONG_RUNNING_TASKS.entries()) {
          const job = BATCH_JOBS[index];
          if (job === undefined) throw new Error("missing job definition");
          const runSuffix = `it-${generateId().slice(-8)}`;
          const appPromise = runLongRunningApp({
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
              configuration: { suite: "val-013-long-running" },
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

          const platformResult = await driveLongRunningExecution({
            executionId: executionId as string,
            job,
            provider: PROVIDER,
            model: MODEL,
            lifecycle,
            dispatch: dispatchSupervisor,
          });

          // The durable long-running facts on the REAL ledger.
          const events = await ctx.port.execute<{ command: string }>({
            sql: `SELECT command FROM executions.execution_events WHERE execution_id = $1 ORDER BY sequence ASC`,
            parameters: [executionId],
          });
          const checkpointEvents = events.rows.filter(
            (row) => row.command === "checkpoint-recorded",
          ).length;
          const resumeDeniedEvents = events.rows.filter(
            (row) => row.command === "resume-denied",
          ).length;

          const appSettled = await appPromise;
          if (!appSettled.ok) {
            throw appSettled.error;
          }
          const violations = validateHarnessEvidence(appSettled.outcome.evidence as never);

          runFacts.push({
            taskIndex: index,
            jobId: job.jobId,
            terminal: platformResult.terminal,
            criteria: platformResult.criteria.map((c) => ({
              criterionId: c.criterionId,
              status: c.status,
            })),
            appPassed: appSettled.outcome.passed,
            segments: platformResult.segments,
            checkpointEvents,
            resumeDeniedEvents,
            noOpResumeReplayed: platformResult.noOpResumeReplayed,
            usage: platformResult.usage,
          });

          expect(violations).toEqual([]);
          const anyFail = platformResult.criteria.some((c) => c.status === "FAIL");
          expect(platformResult.terminal).toBe(anyFail ? "FAILED" : "COMPLETED");
          expect(appSettled.outcome.passed).toBe(
            expectedTerminalFor(index) === platformResult.terminal,
          );
          // The ledger mirrors the driver's checkpoints exactly (every
          // committed item; the corrupted-checkpoint row correctly stops
          // at the corruption boundary — progress never trusted past it).
          expect(checkpointEvents).toBe(platformResult.checkpoints.length);
          if (job.expectedTerminal === "COMPLETED") {
            expect(platformResult.checkpoints.length).toBe(job.items.length);
          }
          // The stale-worker row journaled exactly one denial.
          expect(resumeDeniedEvents).toBe(job.interrupt === "stale-worker" ? 1 : 0);
          // The no-op resume after terminal REPLAYED on the real
          // idempotency ledger (the corpus's "replayed" expectation).
          expect(platformResult.noOpResumeReplayed).toBe(
            job.resumeAfterTerminal === true ? true : null,
          );
          if (platformResult.usage !== null) {
            expect(platformResult.usage.inputTokens).toBeGreaterThan(0);
          }
          void task;
        }

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        const totalCost = runFacts.reduce((sum, fact) => sum + (fact.usage?.costUsd ?? 0), 0);
        const totalInput = runFacts.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0);
        const totalOutput = runFacts.reduce(
          (sum, fact) => sum + (fact.usage?.outputTokens ?? 0),
          0,
        );
        console.info(
          `[VAL-013] REAL run summary: ${completed}/${runFacts.length} COMPLETED (1 designed corruption failure); ` +
            `measured usage ${totalInput}+${totalOutput} tokens, measured cost $${totalCost.toFixed(6)}; ` +
            `model ${MODEL} via ${PROVIDER} (BYOK).`,
        );
        for (const fact of runFacts) {
          console.info(
            `[VAL-013]   ${fact.jobId} -> ${fact.terminal} segments=${fact.segments} ` +
              `checkpoints=${fact.checkpointEvents} resumeDenied=${fact.resumeDeniedEvents} ` +
              `noOpResumeReplayed=${String(fact.noOpResumeReplayed)} ` +
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
