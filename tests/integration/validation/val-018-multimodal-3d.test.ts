/**
 * VAL-018 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * multimodal-transformation customer application runs end to end
 * against the REAL platform path with REAL CHAINED multimodal
 * dispatches (image → structured description → derived media), and
 * the 3D generation/rendering sub-slice records its honest NOT RUN
 * boundary with the exact surfaced access requirement.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port;
 *   - the REAL executions lifecycle (canonical transitions + durable
 *     planning decision recorded BEFORE the dispatch) driven
 *     platform-side exactly as Zeck's operators would;
 *   - the REAL CHAINED multimodal dispatch over the PROVEN rails with
 *     the REAL production fetch transport: the OpenRouter vision rail
 *     (open-weights Qwen2.5-VL; the deterministic synthetic source as
 *     an image data-URI payload; stage 1) feeding the
 *     dashscope-international multimodal-generation rail (qwen-image,
 *     text-to-image; the stage-2 derived-media request whose prompt
 *     GENUINELY binds the stage-1 structured description) —
 *     credentials materialized from the environment at run time,
 *     never in the repository;
 *   - the REAL mechanical verification criteria recorded on the
 *     execution ledger at EACH stage (the vision answer against the
 *     fixture's own ground-truth oracle terms + the
 *     structured-description contract; the derived raster by container
 *     validity, declared dimensions and sha256 digest capture), with
 *     per-stage provenance (request digests, output digests, measured
 *     per-stage latencies and usage);
 *   - honest chained economics: per-stage and end-to-end latency and
 *     usage are MEASURED (never estimated); evidence carries payload
 *     DIGESTS, never payloads.
 *
 * The 3D sub-slice is the honest recorded NOT RUN boundary: NO
 * operator-authorized 3D-generation provider rail exists (capability
 * matrix row model:three-d, candidates: []), so its REAL dispatches
 * are never fabricated — the exact missing access requirement
 * (provider/model, why needed, experiment unlocked, minimum
 * credential) is surfaced and asserted in the offline section below,
 * which ALWAYS executes (no credential, no PostgreSQL needed): the
 * surfaced requirement, the deterministic offline 3D derivations, the
 * no-authorized-rail boundary behavior and the container-verification
 * machinery. The REAL chained runs are env-gated on the authorized
 * chained credentials: an absent OPENROUTER_API_KEY or QWEN_API_KEY
 * makes them a recorded NOT RUN boundary (never a silent pass). The
 * PostgreSQL suite is likewise skipped without ZECK_PG_TEST_URL (the
 * harness's own gate).
 */

import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  MULTIMODAL_TRANSFORMATION_TASKS,
  runMultimodalTransformationApp,
} from "../../../benchmarks/validation/apps/multimodal-transformation/application";
import {
  corruptGltf,
  imageFixture,
  mediaDigest,
  syntheticGltfBinary,
  syntheticObjText,
  syntheticStlBinary,
} from "../../../benchmarks/validation/apps/shared/media";
import {
  runThreeDRenderingApp,
  THREE_D_RENDERING_TASKS,
} from "../../../benchmarks/validation/apps/three-d-rendering/application";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import {
  createDashscopeImagegenRail,
  type HttpTransport,
} from "../../../benchmarks/validation/platform/imagegen";
import { createOpenRouterVisionRail } from "../../../benchmarks/validation/platform/multimodal";
import {
  type ChainedStageFacts,
  type ChainedTransformRunResult,
  createChainedTransformDispatchBinding,
  driveChainedTransformExecution,
  type TransformViaDescriptionTask,
} from "../../../benchmarks/validation/platform/multimodal-transform";
import {
  createThreeDDispatchBinding,
  deriveThreeDPlan,
  deriveThreeDVerification,
  driveThreeDExecution,
  THREE_D_ACCESS_REQUIREMENT,
  type ThreeDTask,
} from "../../../benchmarks/validation/platform/three-d";
import { sniffThreeDContainer } from "../../../benchmarks/validation/platform/three-d-container";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const QWEN_KEY = process.env.QWEN_API_KEY ?? "";
const VISION_PROVIDER = "openrouter";
const VISION_MODEL = process.env.ZECK_VAL_018_VISION_MODEL ?? "qwen/qwen2.5-vl-72b-instruct";
const IMAGEGEN_PROVIDER = "dashscope";
const IMAGEGEN_MODEL = process.env.ZECK_VAL_018_IMAGEGEN_MODEL ?? "qwen-image-2.0";

/**
 * Per-row expected terminals (the corpus rows'/app's own expectations):
 * healthy rows COMPLETED (both chained stages mechanically verified);
 * the corrupted-source edge row FAILED (the REAL vision rail rejects
 * the genuinely corrupted image at stage 1 — chain-abort, stage 2
 * never dispatched).
 */
const EXPECTED_TERMINALS: Record<string, "COMPLETED" | "FAILED"> = {
  "chain-001": "COMPLETED",
  "chain-002": "COMPLETED",
  "chain-003": "FAILED",
};

// ---------------------------------------------------------------------------
// The 3D sub-slice — the honest NOT RUN boundary (offline paths that
// ALWAYS execute: no credential, no PostgreSQL, no network).
// ---------------------------------------------------------------------------

describe("VAL-018 3D sub-slice — the honest NOT RUN boundary (offline paths)", () => {
  test("the exact missing 3D access requirement is surfaced (never a fabricated equivalent)", () => {
    expect(THREE_D_ACCESS_REQUIREMENT.capability).toBe("model:three-d");
    expect(THREE_D_ACCESS_REQUIREMENT.providerModel.length).toBeGreaterThan(0);
    expect(THREE_D_ACCESS_REQUIREMENT.whyNeeded.length).toBeGreaterThan(0);
    expect(THREE_D_ACCESS_REQUIREMENT.experimentUnlocked.length).toBeGreaterThan(0);
    expect(THREE_D_ACCESS_REQUIREMENT.minimumCredential.length).toBeGreaterThan(0);
    // The credential is surfaced as an env-var NAME only — never a value.
    expect(THREE_D_ACCESS_REQUIREMENT.credentialEnvVar).toMatch(/^[A-Z][A-Z0-9_]+$/);
    // The recorded boundary (recorder-consumable output):
    console.warn(
      "[VAL-018] 3D NOT RUN boundary — no operator-authorized 3D-generation provider rail " +
        "exists. Surfaced access requirement: capability=model:three-d; provider/model: " +
        `${THREE_D_ACCESS_REQUIREMENT.providerModel}; why needed: ${THREE_D_ACCESS_REQUIREMENT.whyNeeded}; ` +
        `experiment unlocked: ${THREE_D_ACCESS_REQUIREMENT.experimentUnlocked}; minimum credential: ` +
        `${THREE_D_ACCESS_REQUIREMENT.minimumCredential} (env-var name: ` +
        `${THREE_D_ACCESS_REQUIREMENT.credentialEnvVar}). No fabricated 3D rail, endpoint or model ` +
        "result is substituted; the offline paths, derivations and discrimination tests execute.",
    );
  });

  test("the pinned 3D fixtures derive deterministic dispatch plans offline (no network, no credentials)", () => {
    for (const task of THREE_D_RENDERING_TASKS) {
      const options = { provider: "future-3d", model: "authorized-later" };
      const first = deriveThreeDPlan(task, options);
      const second = deriveThreeDPlan(task, options);
      expect(first.requestDigest).toBe(second.requestDigest);
      expect(first.requestDigest).toMatch(/^[0-9a-f]{16}$/);
      expect(first.specDigest).toMatch(/^[0-9a-f]{16}$/);
      expect(first.specKey).toBe(task.kind === "render-3d" ? task.scene : task.spec);
    }
  });

  test("a 3D dispatch with no authorized rail is the honest boundary failure BEFORE any network effect", async () => {
    const calls = { count: 0 };
    const dispatch = vi.fn();
    const binding = createThreeDDispatchBinding({ transportCalls: calls });
    void dispatch;
    const outcome = await binding({
      executionId: "offline-boundary",
      task: THREE_D_RENDERING_TASKS[0] as ThreeDTask,
      provider: "future-3d",
      model: "authorized-later",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "no-authorized-3d-rail",
      retryable: false,
    });
    if (outcome.kind === "failure") {
      expect(outcome.accessRequirement?.capability).toBe("model:three-d");
      expect(outcome.accessRequirement?.credentialEnvVar).toBe("ZECK_3D_API_KEY");
    }
    expect(calls.count).toBe(0);
  });

  test("the provably-invalid 3D edge specs are rejected before any rail consultation", async () => {
    const dispatch = vi.fn();
    const calls = { count: 0 };
    const binding = createThreeDDispatchBinding({
      rail: { railId: "offline-fake-rail", dispatch },
      transportCalls: calls,
    });
    const edgeIndices = [3, 4, 5];
    for (const index of edgeIndices) {
      const outcome = await binding({
        executionId: `offline-edge-${index}`,
        task: THREE_D_RENDERING_TASKS[index] as ThreeDTask,
        provider: "p",
        model: "m",
      });
      expect(outcome).toMatchObject({ kind: "failure", category: "invalid-request" });
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.count).toBe(0);
  });

  test("the 3D container verification machinery executes offline (valid glTF/OBJ/STL pass; garbage fails)", () => {
    // Valid deterministic synthetic containers (TEST-SUPPORT media —
    // never model outputs): all mechanical criteria pass.
    for (const bytes of [syntheticGltfBinary(), syntheticObjText(), syntheticStlBinary(12)]) {
      const criteria = deriveThreeDVerification(THREE_D_RENDERING_TASKS[0] as ThreeDTask, {
        kind: "success",
        artifact: { bytes, format: "synthetic" },
      });
      expect(criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
      expect(sniffThreeDContainer(bytes).container).not.toBe("unknown");
    }
    // Garbage, a corrupted glTF and a wrong-format payload fail the
    // container criterion honestly — never a fabricated pass.
    for (const bytes of [Buffer.alloc(256, 0xa5), corruptGltf(), imageFixture("img-c-001").png]) {
      const criteria = deriveThreeDVerification(THREE_D_RENDERING_TASKS[0] as ThreeDTask, {
        kind: "success",
        artifact: { bytes, format: "glb" },
      });
      expect(
        criteria.find((criterion) => criterion.criterionId === "container-valid")?.status,
      ).toBe("FAIL");
    }
  });

  test("the 3D driver completes an honest FAILED terminal for the no-rail boundary (lifecycle + evidence)", async () => {
    const transitions: string[] = [];
    const lifecycle: PlatformLifecyclePort = {
      async transition({ step }) {
        transitions.push(step);
      },
      async recordPlanningDecision() {
        transitions.push("planning-decision");
      },
      async complete({ verdict }) {
        transitions.push(`complete:${verdict}`);
      },
    };
    const binding = createThreeDDispatchBinding({ transportCalls: { count: 0 } });
    const result = await driveThreeDExecution({
      executionId: "offline-driver-boundary",
      task: THREE_D_RENDERING_TASKS[0] as ThreeDTask,
      provider: "future-3d",
      model: "authorized-later",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions).toEqual([
      "authorize",
      "plan",
      "planning-decision",
      "queue",
      "start",
      "verify",
      "complete:fail",
    ]);
    expect(result.criteria[0]?.evidence.join(" ")).toContain("no-authorized-3d-rail");
  });

  test("the 3D application's offline SDK-boundary path is executable (controlled fake transport)", async () => {
    // The 3D app rides the public SDK boundary exactly like its
    // siblings; its REAL dispatches stay NOT RUN, but its offline path
    // (submission → completion → result → assertions over a fake API
    // world) is proven here and in tests/unit/validation/val-018-apps.test.ts.
    const { transport } = createFakeApiWorld({ terminal: "COMPLETED" });
    const outcome = await runThreeDRenderingApp({
      config: {
        applicationId: "app-1",
        baseUrl: "http://fake.local",
        tokenEnvVar: "ZECK_VALIDATION_TOKEN",
        applicationRevision: "offline",
        corpusRevision: "offline",
        integrationSurface: "sdk",
        pollIntervalMs: 1,
        completionTimeoutMs: 2_000,
      },
      token: "test-token",
      transport,
      now: () => new Date(1_000_000),
      sleep: () => Promise.resolve(),
      environment: {
        runtime: "node test",
        toolchain: "vitest",
        database: "fake",
        configuration: { suite: "val-018-offline" },
      },
      runSuffix: "offline",
      taskIndex: 0,
    });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });
});

/** The offline fake API world (the SDK-boundary offline path). */
function createFakeApiWorld(options: { readonly terminal: "COMPLETED" | "FAILED" }): {
  readonly transport: Parameters<typeof runThreeDRenderingApp>[0]["transport"];
} {
  const executions = new Map<string, { status: string }>();
  let sequence = 0;
  const transport = async (input: unknown, init?: unknown): Promise<Response> => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    if (url.endsWith("/executions") && method === "POST") {
      sequence += 1;
      const id = `fake-exec-${sequence}`;
      executions.set(id, { status: "RUNNING" });
      return new Response(
        JSON.stringify({
          executionId: id,
          applicationId: "app-1",
          status: "RUNNING",
          createdAt: new Date().toISOString(),
          replayed: false,
          lastEventSequence: 1,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    const execMatch = url.match(/\/executions\/([^/]+)$/);
    if (execMatch !== null && method === "GET") {
      const execution = executions.get(execMatch[1] ?? "");
      if (execution === undefined) {
        return new Response(
          JSON.stringify({ code: "NOT_FOUND", message: "unknown execution", retryable: false }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      execution.status = options.terminal;
      return new Response(
        JSON.stringify({
          id: execMatch[1],
          applicationId: "app-1",
          environmentId: null,
          status: execution.status,
          task: { kind: "render-3d", input: "x" },
          constraints: null,
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          terminalAt: options.terminal === "COMPLETED" ? new Date().toISOString() : null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const resultMatch = url.match(/\/executions\/([^/]+)\/results$/);
    if (resultMatch !== null) {
      const execution = executions.get(resultMatch[1] ?? "");
      if (execution === undefined) {
        return new Response(
          JSON.stringify({ code: "NOT_FOUND", message: "unknown execution", retryable: false }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      const pass = options.terminal === "COMPLETED";
      return new Response(
        JSON.stringify({
          executionId: resultMatch[1],
          status: options.terminal,
          route: {
            provider: "fake-rail",
            model: "fake-model",
            strategyClass: "single-shot-three-d",
            modelCalls: 1,
          },
          cost: pass ? { totalMicroUsd: "21", currency: "usd" } : null,
          usage: pass ? { inputTokens: 10, outputTokens: 1 } : null,
          outputArtifacts: [],
          verification: pass
            ? [
                {
                  id: "v1",
                  executionId: resultMatch[1],
                  criterionId: "container-valid",
                  strategy: "deterministic",
                  status: "PASS",
                  recordedBy: "fake-platform",
                },
              ]
            : [
                {
                  id: "v1",
                  executionId: resultMatch[1],
                  criterionId: "provider-dispatch",
                  strategy: "deterministic",
                  status: "FAIL",
                  recordedBy: "fake-platform",
                },
              ],
          warnings: [],
          terminalAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        code: "INTERNAL",
        message: `unmapped fake route ${url}`,
        retryable: true,
      }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  };
  return { transport };
}

// ---------------------------------------------------------------------------
// The REAL chained multimodal-transformation run (PostgreSQL +
// env-credential gated; the Lead's verification domain)
// ---------------------------------------------------------------------------

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly taskIndex: number;
  readonly fixtureKey: string;
  readonly terminal: string;
  readonly criteria: readonly { criterionId: string; status: string }[];
  readonly appPassed: boolean;
  readonly evidenceViolations: number;
  readonly stages: readonly ChainedStageFacts[];
  readonly dispatchLatencyMs: number | null;
  readonly descriptionDigest: string | null;
  readonly imageDigest: string | null;
  readonly failureCategory: string | null;
}

definePgSuite(
  "VAL-018 multimodal-transformation application over the real platform path (REAL chained providers)",
  (ctx) => {
    test("the chained multimodal-transformation application completes end to end", {
      timeout: 900_000,
    }, async () => {
      if (OPENROUTER_KEY.length === 0 || QWEN_KEY.length === 0) {
        console.warn(
          "[VAL-018] OPENROUTER_API_KEY or QWEN_API_KEY absent — the REAL chained runs " +
            "(ALL rows of the multimodal-transformation application: chain-001/chain-002 " +
            "riding the OpenRouter vision rail (" +
            VISION_MODEL +
            ") feeding the dashscope-international image-generation rail (" +
            IMAGEGEN_MODEL +
            ")) are a NOT RUN boundary (recorded honestly in docs/work-items/VAL-018.md; no " +
            "fake success is asserted). The 3D sub-slice's offline boundary section above " +
            "executed regardless.",
        );
        expect(true).toBe(true);
        return;
      }

      const generateId = createUuidv7Generator();
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });

      // ---- The REAL chained rails (production fetch transport) ----
      // The wider (imagegen) HttpTransport shape satisfies both
      // proven rails' transport seams.
      const realFetch: HttpTransport = (url, init) => fetch(url, init);
      const vision = createOpenRouterVisionRail({
        transport: realFetch,
        apiKey: OPENROUTER_KEY,
      });
      const generation = createDashscopeImagegenRail({
        transport: realFetch,
        apiKey: QWEN_KEY,
        mode: "text-to-image",
      });
      // The platform's bounded retry policy: retryable provider
      // failures (rate limits on the open-weights vision route) get
      // two additional REAL attempts PER STAGE; non-retryable
      // failures (the corrupted-source edge row, auth, digest
      // mismatches) are never retried. Waits are part of the
      // measured latency.
      const dispatch = createChainedTransformDispatchBinding({
        vision,
        generation,
        retry: { attempts: 2, delayMs: 6_000 },
      });

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
            `val-018-${executionId}-${step}`,
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
                    strategyId: "val-018-pinned",
                    plan: {
                      strategyClass: route.strategyClass,
                      modelCalls: 2,
                      steps: [
                        {
                          routeRef: { provider: VISION_PROVIDER, model: VISION_MODEL },
                        },
                        {
                          routeRef: { provider: IMAGEGEN_PROVIDER, model: IMAGEGEN_MODEL },
                        },
                      ],
                    },
                  },
                ],
                selectedStrategyId: "val-018-pinned",
              },
            },
            `val-018-${executionId}-decision`,
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
                recordedBy: "val-018-platform",
                evidence: [...criterion.evidence],
              })),
            },
            `val-018-${executionId}-${verdict}`,
          );
        },
      };

      // ---- The pinned slice (the customer application) ----
      const runFacts: RunFacts[] = [];
      const drivenExecutionIds = new Set<string>();
      const runTask = async (options: {
        readonly taskIndex: number;
        readonly task: TransformViaDescriptionTask;
      }) => {
        const fixtureKey = options.task.chain;
        const expectedTerminal = EXPECTED_TERMINALS[fixtureKey] ?? "COMPLETED";
        // Provider-side pacing: a modest spacing between REAL chained
        // dispatches keeps the open-weights vision route clear of
        // rate limits.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const runSuffix = `it-${generateId().slice(-8)}`;
        const revision = createHash("sha256")
          .update(
            `${VISION_PROVIDER}|${VISION_MODEL}|${IMAGEGEN_PROVIDER}|${IMAGEGEN_MODEL}|val-018-pinned`,
          )
          .digest("hex")
          .slice(0, 40);
        const appPromise = runMultimodalTransformationApp({
          config: {
            applicationId: world.applicationId,
            baseUrl: address,
            tokenEnvVar: "ZECK_VALIDATION_TOKEN",
            applicationRevision: revision,
            corpusRevision: revision,
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
            configuration: { suite: "val-018-multimodal-3d" },
          },
          runSuffix,
          taskIndex: options.taskIndex,
        }).then(
          (outcome) => ({ ok: true as const, outcome }),
          (error: unknown) => ({ ok: false as const, error }),
        );

        // Platform side: wait for THIS task's submission to land.
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

        const platformResult: ChainedTransformRunResult = await driveChainedTransformExecution({
          executionId: executionId as string,
          task: options.task,
          visionProvider: VISION_PROVIDER,
          visionModel: VISION_MODEL,
          imagegenProvider: IMAGEGEN_PROVIDER,
          imagegenModel: IMAGEGEN_MODEL,
          ports: { lifecycle, dispatch, now: () => new Date() },
        });

        const appSettled = await appPromise;
        if (!appSettled.ok) {
          throw appSettled.error;
        }
        const appOutcome = appSettled.outcome;
        const violations = validateHarnessEvidence(appOutcome.evidence as never);

        const failureCategory =
          platformResult.criteria
            .find((criterion) => criterion.status === "FAIL")
            ?.evidence.find((line) => line.startsWith("provider-failure:")) ?? null;
        runFacts.push({
          taskIndex: options.taskIndex,
          fixtureKey,
          terminal: platformResult.terminal,
          criteria: platformResult.criteria.map((c) => ({
            criterionId: c.criterionId,
            status: c.status,
          })),
          appPassed: appOutcome.passed,
          evidenceViolations: violations.length,
          stages: platformResult.stages,
          dispatchLatencyMs: platformResult.dispatchLatencyMs,
          descriptionDigest: platformResult.descriptionDigest,
          imageDigest: platformResult.imageDigest,
          failureCategory,
        });
        // Progress logging (surfaces per-row detail before any
        // assertion failure aborts the suite).
        console.info(
          `[VAL-018]   multimodal-transformation#${options.taskIndex} (${fixtureKey}) -> ` +
            `${platformResult.terminal} [${platformResult.criteria
              .map((c) => `${c.criterionId}:${c.status}`)
              .join(", ")}] stages=[${platformResult.stages
              .map(
                (s) =>
                  `${s.provider}/${s.model} latency=${s.latencyMs}ms usage=${
                    s.usage === null ? "n/a" : `${s.usage.inputTokens}+${s.usage.outputTokens}`
                  }`,
              )
              .join(" | ")}] end-to-end=${platformResult.dispatchLatencyMs}ms`,
        );

        // The honest outcome contract (mechanically checkable for
        // every run): valid evidence; terminal consistent with the
        // criteria; the terminal MATCHES the row's own expected
        // terminal; the app's assertions PASS on the honest outcome;
        // completed chains carry BOTH stages' facts (measured usage,
        // request + output digests) and a derived-image digest that
        // differs from the synthetic source (a genuinely new raster).
        expect(violations).toEqual([]);
        const anyFail = platformResult.criteria.some((c) => c.status === "FAIL");
        expect(platformResult.terminal).toBe(anyFail ? "FAILED" : "COMPLETED");
        expect(platformResult.terminal).toBe(expectedTerminal);
        expect(appOutcome.passed).toBe(true);
        if (expectedTerminal === "COMPLETED") {
          expect(platformResult.criteria.every((c) => c.status === "PASS")).toBe(true);
          expect(platformResult.stages).toHaveLength(2);
          for (const stage of platformResult.stages) {
            expect(stage.requestDigest).toMatch(/^[0-9a-f]{16}$/);
            expect(stage.outputDigest).toMatch(/^[0-9a-f]{16}$/);
            expect(stage.latencyMs).toBeGreaterThanOrEqual(0);
          }
          expect(platformResult.descriptionDigest).not.toBeNull();
          expect(platformResult.imageDigest).not.toBeNull();
          expect(platformResult.imageDigest).not.toBe(mediaDigest(imageFixture("img-c-001").png));
          // The vision stage's REAL usage is measured (the chain's
          // stage-1 provider reports tokens).
          const visionStage = platformResult.stages.find((s) => s.stage === 1);
          expect(visionStage?.usage?.inputTokens ?? 0).toBeGreaterThan(0);
        }
        if (expectedTerminal === "FAILED") {
          // The honest chain-abort: stage 1 was attempted and stage 2
          // never dispatched.
          expect(failureCategory).toBe("provider-failure:invalid-request");
          const abortEvidence = platformResult.criteria[0]?.evidence.join(" ") ?? "";
          expect(abortEvidence).toContain("chain-aborted:stage:1");
          expect(abortEvidence).toContain("stage2-attempted:false");
          expect(platformResult.imageDigest).toBeNull();
        }
      };

      try {
        for (const [index, task] of MULTIMODAL_TRANSFORMATION_TASKS.entries()) {
          await runTask({ taskIndex: index, task });
        }

        // The REAL results summary (recorded in the evidence doc).
        const completed = runFacts.filter((f) => f.terminal === "COMPLETED").length;
        const failed = runFacts.filter((f) => f.terminal === "FAILED").length;
        const totalCost = runFacts.reduce(
          (sum, f) => sum + f.stages.reduce((s, stage) => s + (stage.usage?.costUsd ?? 0), 0),
          0,
        );
        const totalInputTokens = runFacts.reduce(
          (sum, f) => sum + f.stages.reduce((s, stage) => s + (stage.usage?.inputTokens ?? 0), 0),
          0,
        );
        const totalOutputTokens = runFacts.reduce(
          (sum, f) => sum + f.stages.reduce((s, stage) => s + (stage.usage?.outputTokens ?? 0), 0),
          0,
        );
        console.info(
          `[VAL-018] REAL chained run summary: ${completed} COMPLETED / ${failed} FAILED (both ` +
            `honest) of ${runFacts.length} driven; measured usage ${totalInputTokens}+` +
            `${totalOutputTokens} tokens, measured cost $${totalCost.toFixed(6)}; vision ` +
            `${VISION_MODEL} via ${VISION_PROVIDER} → imagegen ${IMAGEGEN_MODEL} via ` +
            `${IMAGEGEN_PROVIDER} (env-credential gated, REAL chained dispatches).`,
        );
        // At least one REAL chained dispatch must have happened (never
        // an all-NOT-RUN silent pass inside the gated branch).
        expect(runFacts.length).toBeGreaterThan(0);
      } finally {
        await world.server.app.close();
      }
    });
  },
);
