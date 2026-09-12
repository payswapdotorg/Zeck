/**
 * VAL-018 acceptance criteria 3, 4, 5, 7 — the crown proof: the
 * multimodal-transformation customer-style application runs end to end
 * against the REAL platform path with a REAL chained multimodal
 * dispatch (vision -> structured description -> derived media over the
 * two proven rails), and the three-d sub-slice is an honest recorded
 * NOT RUN boundary (no 3D provider rail exists in the authorized
 * access set) whose offline paths, derivations and discrimination
 * tests still execute.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port;
 *   - the REAL executions lifecycle (canonical transitions + durable
 *     per-stage planning decisions recorded BEFORE the dispatch)
 *     driven platform-side exactly as Zeck's operators would;
 *   - the REAL chained dispatch over the two proven REAL rails with
 *     the REAL production fetch transport: the OpenRouter vision rail
 *     (stage 1: image data-URI + the seeded structured-description
 *     instruction) and the dashscope-international
 *     multimodal-generation rail (stage 3: the derived prompt as a
 *     text-to-image request) — credentials materialized from the
 *     environment at run time, never in the repository;
 *   - the REAL mechanical verification criteria recorded on the
 *     execution ledger at EVERY chain stage (each stage verified
 *     before the next consumes it; chain-abort propagation records the
 *     exact failing stage; the applications assert the verified
 *     outcome).
 *
 * Per-stage credential gates: the healthy chain rows need BOTH the
 * vision credential (OPENROUTER_API_KEY — stage 1) and the derived-media
 * credential (QWEN_API_KEY — stage 3); the corrupted-source row aborts
 * at stage 1 (its designed abort point) and needs only the vision
 * credential; the wrong-modality rejection row is a pre-dispatch
 * rejection and needs NO credential. The 3D rows are PERMANENTLY NOT
 * RUN until operator-authorized 3D access exists (the missing access
 * requirement is surfaced in docs/work-items/VAL-018.md; never a
 * fabricated equivalent). Every absent-credential boundary is recorded
 * honestly; never a silent pass.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  MULTIMODAL_TRANSFORMATION_TASKS,
  runMultimodalTransformationApp,
} from "../../../benchmarks/validation/apps/multimodal-transformation/application";
import {
  createMultimodalTransformationBinding,
  driveMultimodalTransformationExecution,
} from "../../../benchmarks/validation/apps/multimodal-transformation/chain";
import { DERIVED_MEDIA_SIZE } from "../../../benchmarks/validation/apps/multimodal-transformation/fixtures";
import { createCanvas } from "../../../benchmarks/validation/apps/shared/media";
import { threeDPromptFixture } from "../../../benchmarks/validation/apps/shared/three-d-scenes";
import { THREE_D_RENDERING_TASKS } from "../../../benchmarks/validation/apps/three-d-rendering/application";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import { createDashscopeImagegenRail } from "../../../benchmarks/validation/platform/imagegen";
import {
  createMultimodalDispatchBinding,
  createOpenRouterVisionRail,
  type HttpTransport,
} from "../../../benchmarks/validation/platform/multimodal";
import {
  createThreeDDispatchBinding,
  deriveThreeDPlan,
  deriveThreeDVerification,
  materializeThreeDInput,
  THREE_D_ACCESS_REQUIREMENT,
} from "../../../benchmarks/validation/platform/three-d";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const QWEN_KEY = process.env.QWEN_API_KEY ?? "";
const VISION_PROVIDER = "openrouter";
const VISION_MODEL = process.env.ZECK_VAL_017_VISION_MODEL ?? "qwen/qwen2.5-vl-72b-instruct";
const IMAGEGEN_PROVIDER = "dashscope";
const IMAGEGEN_MODEL = process.env.ZECK_VAL_015_IMAGE_MODEL ?? "qwen-image-2.0";

/** Per-task oracle truth: the source fixtures' own ground truth. */
const ORACLES: Record<string, readonly string[]> = {
  "img-c-001": ["bus"],
  "scene-001": ["bus"],
  "scene-004": ["rising"],
  "img-corrupt": [],
};

/** Per-row expected terminals (the corpus rows'/apps' own expectations). */
const EXPECTED_TERMINALS: Record<string, "COMPLETED" | "FAILED"> = {
  "multimodal-transformation#0": "COMPLETED",
  "multimodal-transformation#1": "COMPLETED",
  "multimodal-transformation#2": "COMPLETED",
  // The corrupted-source edge row: the chain aborts at the vision stage
  // (the REAL provider rejects genuinely undecodable media).
  "multimodal-transformation#3": "FAILED",
  // The wrong-modality rejection row: rejected BEFORE any network effect.
  "multimodal-transformation#4": "FAILED",
};

/** Which chain stages each row needs (per-stage credential gating). */
const ROW_STAGE_NEEDS: Record<string, readonly ("vision" | "derived-media")[]> = {
  "multimodal-transformation#0": ["vision", "derived-media"],
  "multimodal-transformation#1": ["vision", "derived-media"],
  "multimodal-transformation#2": ["vision", "derived-media"],
  // The corrupted row aborts at stage 1 by design (its chain never
  // reaches the derived-media stage — VAL-017 verified the exact REAL
  // provider 400 on this fixture).
  "multimodal-transformation#3": ["vision"],
  // The wrong-modality row is a pre-dispatch rejection: zero dispatches.
  "multimodal-transformation#4": [],
};

/** Per-run REAL facts collected for the evidence document. */
interface ChainRunFacts {
  readonly app: string;
  readonly taskIndex: number;
  readonly fixtureKey: string;
  readonly terminal: string;
  readonly criteria: readonly { criterionId: string; status: string }[];
  readonly appPassed: boolean;
  readonly evidenceViolations: number;
  readonly stages: readonly {
    readonly stageId: string;
    readonly executed: boolean;
    readonly requestDigest: string | null;
    readonly responseDigest: string | null;
    readonly latencyMs: number | null;
    readonly usage: { inputTokens: number; outputTokens: number } | null;
    readonly failed: boolean;
  }[];
  readonly usage: { inputTokens: number; outputTokens: number; costUsd: number | null } | null;
  readonly dispatchLatencyMs: number | null;
  readonly derivedMediaDigest: string | null;
  readonly derivedMediaDimensions: string | null;
  readonly derivedMediaRequestDigest: string | null;
  readonly abortedAtStage: string | null;
}

definePgSuite("VAL-018 multimodal transformation + three-d over the real platform path", (ctx) => {
  test("multimodal-transformation chains end to end; three-d honestly NOT RUN", {
    timeout: 900_000,
  }, async () => {
    const visionOk = OPENROUTER_KEY.length > 0;
    const derivedOk = QWEN_KEY.length > 0;
    if (!visionOk) {
      console.warn(
        "[VAL-018] OPENROUTER_API_KEY absent — the REAL vision stage (stage 1) is a NOT RUN " +
          "boundary: the healthy chain rows and the corrupted-source row are NOT RUN; the " +
          "credential-free wrong-modality row and the three-d offline proofs still execute.",
      );
    }
    if (!derivedOk) {
      console.warn(
        "[VAL-018] QWEN_API_KEY absent — the REAL derived-media stage (stage 3) is a NOT RUN " +
          "boundary: the healthy chain rows are NOT RUN; the corrupted-source row (aborting at " +
          "stage 1), the credential-free wrong-modality row and the three-d offline proofs " +
          "still execute.",
      );
    }

    const generateId = createUuidv7Generator();
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });

    // ---- The REAL rails (production fetch transport, env-credential gated) ----
    // The loose production fetch satisfies both declared transport shapes
    // at runtime (the imagegen rail also issues body-less GET polls).
    const realFetch = ((url: string, init: Parameters<typeof fetch>[1]) =>
      fetch(url, init)) as unknown as HttpTransport;
    const realFetchImagegen = realFetch as unknown as Parameters<
      typeof createDashscopeImagegenRail
    >[0]["transport"];
    const visionRail = visionOk
      ? createOpenRouterVisionRail({ transport: realFetch, apiKey: OPENROUTER_KEY })
      : undefined;
    // Stage 1 rides the EXISTING multimodal dispatch binding: its own
    // discriminations and bounded retry apply (two additional REAL
    // attempts for retryable failures; the corrupted-media 400 is
    // non-retryable). Waits are part of the measured latency.
    const visionDispatch = createMultimodalDispatchBinding({
      vision: visionRail,
      retry: { attempts: 2, delayMs: 6_000 },
    });
    const imagegenRail = derivedOk
      ? createDashscopeImagegenRail({
          transport: realFetchImagegen,
          apiKey: QWEN_KEY,
          mode: "text-to-image",
        })
      : undefined;
    const chainDispatch = createMultimodalTransformationBinding({
      visionDispatch,
      visionProvider: VISION_PROVIDER,
      visionModel: VISION_MODEL,
      imagegenRail,
      imagegenProvider: IMAGEGEN_PROVIDER,
      imagegenModel: IMAGEGEN_MODEL,
      derivedMediaSize: DERIVED_MEDIA_SIZE,
      imagegenRetry: { attempts: 2, delayMs: 6_000 },
      now: () => new Date(),
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
                    modelCalls: 1,
                    steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                  },
                },
              ],
              selectedStrategyId: "val-018-pinned",
            },
          },
          // 2026-09-12 Lead review fix: the chain driver records ONE
          // planning decision PER STAGE ROUTE (vision + derived media) —
          // the idempotency key must therefore be per-stage (keyed by the
          // route's provider+model), or the ledger correctly rejects the
          // second decision as IDEMPOTENCY_KEY_REUSED (same key, different
          // fingerprint). Deterministic per stage: a replay of the same
          // stage decision matches its own key + fingerprint.
          `val-018-${executionId}-decision-${route.provider}-${route.model}`,
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

    // ---- The pinned chain slice (customer application rows) ----
    const runFacts: ChainRunFacts[] = [];
    const notRun: string[] = [];
    const drivenExecutionIds = new Set<string>();
    const runRow = async (options: { readonly taskIndex: number }) => {
      const task =
        MULTIMODAL_TRANSFORMATION_TASKS[options.taskIndex] ?? MULTIMODAL_TRANSFORMATION_TASKS[0];
      if (task === undefined) {
        throw new Error(`no pinned row at index ${options.taskIndex}`);
      }
      const rowKey = `multimodal-transformation#${options.taskIndex}`;
      const fixtureKey =
        task.kind === "transform-multimodal"
          ? `${task.source}+${task.instruction}`
          : `${task.source}+${task.edit} (foreign kind: ${task.kind})`;
      const expectedTerminal = EXPECTED_TERMINALS[rowKey] ?? "COMPLETED";
      // Per-stage credential gating (the honest NOT RUN boundaries).
      const needs = ROW_STAGE_NEEDS[rowKey] ?? ["vision", "derived-media"];
      const missing: string[] = [];
      if (needs.includes("vision") && !visionOk) {
        missing.push("vision stage (OPENROUTER_API_KEY absent)");
      }
      if (needs.includes("derived-media") && !derivedOk) {
        missing.push("derived-media stage (QWEN_API_KEY absent)");
      }
      if (missing.length > 0) {
        notRun.push(`${rowKey} (${fixtureKey}) — ${missing.join("; ")}`);
        return;
      }
      // Provider-side pacing: a modest spacing between REAL dispatches.
      if (needs.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      const runSuffix = `it-${generateId().slice(-8)}`;
      const appPromise = runMultimodalTransformationApp({
        config: {
          applicationId: world.applicationId,
          baseUrl: address,
          tokenEnvVar: "ZECK_VALIDATION_TOKEN",
          applicationRevision: createHash("sha256")
            .update(`${VISION_PROVIDER}|${VISION_MODEL}|${IMAGEGEN_MODEL}|val-018-pinned`)
            .digest("hex")
            .slice(0, 40),
          corpusRevision: createHash("sha256")
            .update(`${VISION_PROVIDER}|${VISION_MODEL}|${IMAGEGEN_MODEL}|val-018-pinned`)
            .digest("hex")
            .slice(0, 40),
          integrationSurface: "sdk",
          pollIntervalMs: 250,
          completionTimeoutMs: 600_000,
        },
        token: world.bearerToken,
        transport: globalThis.fetch,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        environment: {
          runtime: `node ${process.version}`,
          toolchain: "vitest",
          database: "postgresql",
          configuration: { suite: "val-018-3d-transform" },
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

      const platformResult = await driveMultimodalTransformationExecution({
        executionId: executionId as string,
        task,
        route: {
          visionProvider: VISION_PROVIDER,
          visionModel: VISION_MODEL,
          imagegenProvider: IMAGEGEN_PROVIDER,
          imagegenModel: IMAGEGEN_MODEL,
        },
        oracle: {
          containsText:
            task.kind === "transform-multimodal" ? [...(ORACLES[task.source] ?? [])] : [],
        },
        ports: { lifecycle, dispatch: chainDispatch, now: () => new Date() },
      });

      const appSettled = await appPromise;
      if (!appSettled.ok) {
        throw appSettled.error;
      }
      const appOutcome = appSettled.outcome;
      const violations = validateHarnessEvidence(appOutcome.evidence as never);

      runFacts.push({
        app: "multimodal-transformation",
        taskIndex: options.taskIndex,
        fixtureKey,
        terminal: platformResult.terminal,
        criteria: platformResult.criteria.map((c) => ({
          criterionId: c.criterionId,
          status: c.status,
        })),
        appPassed: appOutcome.passed,
        evidenceViolations: violations.length,
        stages: platformResult.stages.map((stage) => ({
          stageId: stage.stageId,
          executed: stage.executed,
          requestDigest: stage.requestDigest,
          responseDigest: stage.responseDigest,
          latencyMs: stage.latencyMs,
          usage:
            stage.usage === null
              ? null
              : { inputTokens: stage.usage.inputTokens, outputTokens: stage.usage.outputTokens },
          failed: stage.failure !== null || stage.criteria.some((c) => c.status === "FAIL"),
        })),
        usage:
          platformResult.usage === null
            ? null
            : {
                inputTokens: platformResult.usage.inputTokens,
                outputTokens: platformResult.usage.outputTokens,
                costUsd: platformResult.usage.costUsd ?? null,
              },
        dispatchLatencyMs: platformResult.dispatchLatencyMs,
        derivedMediaDigest: platformResult.derivedMediaDigest,
        derivedMediaDimensions:
          platformResult.derivedMediaDimensions === null
            ? null
            : `${platformResult.derivedMediaDimensions.width}x${platformResult.derivedMediaDimensions.height}`,
        derivedMediaRequestDigest: platformResult.derivedMediaRequestDigest,
        abortedAtStage: platformResult.abortedAtStage,
      });
      // Progress logging (per-stage detail surfaces before any
      // assertion failure aborts the suite).
      console.info(
        `[VAL-018]   ${rowKey} (${fixtureKey}) -> ${platformResult.terminal}` +
          `${platformResult.abortedAtStage === null ? "" : ` [aborted at ${platformResult.abortedAtStage}]`} ` +
          `[${platformResult.criteria.map((c) => `${c.criterionId}:${c.status}`).join(", ")}] ` +
          `stages=[${platformResult.stages
            .map(
              (stage) =>
                `${stage.stageId}:${stage.executed ? (stage.latencyMs ?? 0) : "not-executed"}ms`,
            )
            .join(", ")}] ` +
          `usage=${platformResult.usage === null ? "n/a" : `${platformResult.usage.inputTokens}+${platformResult.usage.outputTokens}`} ` +
          `latency=${platformResult.dispatchLatencyMs}ms ` +
          `derived=${platformResult.derivedMediaDigest ?? "n/a"}`,
      );

      // The honest outcome contract (mechanically checkable for every
      // driven run): valid evidence; terminal consistent with the
      // criteria; the terminal MATCHES the row's own expected terminal;
      // the apps' assertions PASS on the honest outcome; per-stage
      // provenance is complete on healthy chains; REAL usage on
      // completed runs.
      expect(violations).toEqual([]);
      const anyFail = platformResult.criteria.some((c) => c.status === "FAIL");
      expect(platformResult.terminal).toBe(anyFail ? "FAILED" : "COMPLETED");
      expect(platformResult.terminal).toBe(expectedTerminal);
      expect(appOutcome.passed).toBe(true);
      if (expectedTerminal === "COMPLETED") {
        expect(platformResult.criteria.every((c) => c.status === "PASS")).toBe(true);
        expect(platformResult.stages.every((stage) => stage.executed)).toBe(true);
        expect(platformResult.derivedMediaDigest).not.toBeNull();
        expect(platformResult.derivedMediaDimensions).not.toBeNull();
        expect(platformResult.derivedMediaRequestDigest).not.toBeNull();
        // The chaining is visible: stage 2's request digest IS stage
        // 1's response digest.
        expect(platformResult.stages[1]?.requestDigest).toBe(
          platformResult.stages[0]?.responseDigest,
        );
      }
      if (expectedTerminal === "FAILED") {
        // The EXACT abort stage is recorded (chain-abort propagation).
        const aborted = platformResult.criteria.find((c) => c.criterionId === "chain-aborted");
        const rejected = platformResult.criteria.find((c) => c.criterionId === "chain-rejected");
        expect(aborted !== undefined || rejected !== undefined).toBe(true);
        if (rowKey === "multimodal-transformation#3") {
          expect(platformResult.abortedAtStage).toBe("vision");
          expect(aborted?.evidence).toContain("stage:vision");
        }
        if (rowKey === "multimodal-transformation#4") {
          expect(rejected?.evidence[0]).toBe("category:wrong-modality");
        }
      }
      if (platformResult.usage !== null && platformResult.terminal === "COMPLETED") {
        expect(platformResult.usage.inputTokens).toBeGreaterThan(0);
        expect(platformResult.usage.outputTokens).toBeGreaterThan(0);
      }
    };

    try {
      for (const [index] of MULTIMODAL_TRANSFORMATION_TASKS.entries()) {
        await runRow({ taskIndex: index });
      }

      // ---- The three-d sub-slice: an honest NOT RUN boundary ----
      // No 3D generation provider rail exists in the authorized
      // access set. The REAL dispatches of the three-d rows are NOT
      // RUN (recorded honestly — never a fabricated equivalent; the
      // exact missing access requirement is surfaced in the evidence
      // document). The offline paths, derivations and discriminations
      // still execute below.
      const railCalls = { count: 0 };
      const threeDBinding = createThreeDDispatchBinding({ railCalls });
      for (const [index, task] of THREE_D_RENDERING_TASKS.entries()) {
        notRun.push(
          `three-d-rendering#${index} (${task.prompt || "(empty prompt)"}/${task.geometry.primitive}) ` +
            "— three-d rail absent (no authorized 3D provider exists; the access requirement " +
            "is surfaced in docs/work-items/VAL-018.md)",
        );
        // Offline path 1: deterministic materialization (same key ->
        // same prompt text, same digest; the geometry passes through).
        const materialized = materializeThreeDInput(task);
        expect(materialized.prompt).toBe(threeDPromptFixture(task.prompt).prompt);
        expect(materialized.promptDigest).toMatch(/^[0-9a-f]{16}$/);
        // Offline path 2: plan derivation + request-level
        // reproducibility (the request that a rail WOULD receive).
        const plan = deriveThreeDPlan(task, { provider: "none", model: "none" });
        const planAgain = deriveThreeDPlan(task, { provider: "none", model: "none" });
        expect(plan.requestDigest).toBe(planAgain.requestDigest);
        expect(plan.prompt).toBe(materialized.prompt);
        // Offline path 3: the honest rail-absent boundary (driven
        // binding, zero rail calls, never a fabricated artifact).
        const outcome = await threeDBinding({
          executionId: `offline-3d-${index}`,
          task,
          provider: "none",
          model: "none",
        });
        if (
          task.prompt === "" ||
          task.geometry.dimensions.some((d) => d <= 0) ||
          task.geometry.resolution < 1
        ) {
          // The edge rows are pre-dispatch rejections (honest FAILURES,
          // matching the corpus rows' own expectations).
          expect(outcome.kind).toBe("failure");
          expect(["invalid-request", "invalid-geometry"]).toContain(
            outcome.kind === "failure" ? outcome.category : "",
          );
        } else {
          // The healthy rows hit the honest NOT RUN boundary.
          expect(outcome).toMatchObject({ kind: "failure", category: "three-d-rail-absent" });
        }
        expect(railCalls.count).toBe(0); // ZERO rail calls across every row
      }
      // Offline path 4: the mechanical 3D verification criteria over
      // synthetic artifacts (container validity + digest — proven
      // against the shapes a future rail delivers).
      const syntheticGlb = ((): Buffer => {
        const json = Buffer.from('{"asset":{"version":"2.0"},"scenes":[{}],"scene":0}', "utf8");
        const header = Buffer.alloc(12);
        header.writeUInt32LE(0x46546c67, 0);
        header.writeUInt32LE(2, 4);
        header.writeUInt32LE(12 + 8 + json.length, 8);
        const chunkHeader = Buffer.alloc(8);
        chunkHeader.writeUInt32LE(json.length, 0);
        chunkHeader.writeUInt32LE(0x4e4f534a, 4);
        return Buffer.concat([header, chunkHeader, json]);
      })();
      const syntheticObj = Buffer.from(
        "# synthetic mesh\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
        "utf8",
      );
      const glbTask = THREE_D_RENDERING_TASKS[0];
      const glbCriteria = deriveThreeDVerification(glbTask, {
        kind: "success",
        artifact: { bytes: syntheticGlb, container: "glb" },
      });
      expect(glbCriteria.every((c) => c.status === "PASS")).toBe(true);
      const objTask = THREE_D_RENDERING_TASKS[2];
      const objCriteria = deriveThreeDVerification(objTask, {
        kind: "success",
        artifact: { bytes: syntheticObj, container: "obj" },
      });
      expect(objCriteria.every((c) => c.status === "PASS")).toBe(true);
      const garbageCriteria = deriveThreeDVerification(glbTask, {
        kind: "success",
        artifact: { bytes: Buffer.alloc(512, 0xa5), container: "unknown" },
      });
      expect(garbageCriteria.some((c) => c.status === "FAIL")).toBe(true);
      // Offline path 5: the surfaced missing access requirement.
      expect(THREE_D_ACCESS_REQUIREMENT.capability).toBe("model:three-d");
      console.info(
        `[VAL-018] Surfaced 3D access requirement (per the roadmap's provider-access policy): ` +
          `capability=${THREE_D_ACCESS_REQUIREMENT.capability}; candidates=${THREE_D_ACCESS_REQUIREMENT.providerCandidates
            .map((c) => `${c.provider} (${c.models.join("/")})`)
            .join(", ")}; minimum credential=${THREE_D_ACCESS_REQUIREMENT.minimumCredential}`,
      );
      // A deterministic synthetic raster sanity anchor for the offline
      // battery (the same recipe the unit suite pins).
      const canvas = createCanvas(16, 16);
      canvas.fillRect(0, 0, 16, 16, [250, 250, 250]);
      expect(canvas.toPng().length).toBeGreaterThan(0);

      // The REAL results summary (recorded in the evidence doc).
      const completed = runFacts.filter((f) => f.terminal === "COMPLETED").length;
      const failed = runFacts.filter((f) => f.terminal === "FAILED").length;
      const totalCost = runFacts.reduce((sum, f) => sum + (f.usage?.costUsd ?? 0), 0);
      const totalInputTokens = runFacts.reduce((sum, f) => sum + (f.usage?.inputTokens ?? 0), 0);
      const totalOutputTokens = runFacts.reduce((sum, f) => sum + (f.usage?.outputTokens ?? 0), 0);
      console.info(
        `[VAL-018] REAL chain run summary: ${completed} COMPLETED / ${failed} FAILED (both ` +
          `honest) of ${runFacts.length} driven; measured usage ${totalInputTokens}+${totalOutputTokens} tokens, ` +
          `measured cost $${totalCost.toFixed(6)}; vision ${VISION_MODEL} via ${VISION_PROVIDER} + ` +
          `derived media ${IMAGEGEN_MODEL} via ${IMAGEGEN_PROVIDER} (env-credential gated per stage).`,
      );
      for (const fact of runFacts) {
        console.info(
          `[VAL-018]   ${fact.app}#${fact.taskIndex} (${fact.fixtureKey}) -> ${fact.terminal}` +
            `${fact.abortedAtStage === null ? "" : ` [aborted at ${fact.abortedAtStage}]`} ` +
            `[${fact.criteria.map((c) => `${c.criterionId}:${c.status}`).join(", ")}] ` +
            `stages=[${fact.stages
              .map((s) => `${s.stageId}:${s.executed ? `${s.latencyMs ?? 0}ms` : "not-executed"}`)
              .join(", ")}] ` +
            `usage=${fact.usage ? `${fact.usage.inputTokens}+${fact.usage.outputTokens}/$${(fact.usage.costUsd ?? 0).toFixed(6)}` : "n/a"} ` +
            `latency=${fact.dispatchLatencyMs}ms derived=${fact.derivedMediaDigest ?? "n/a"} ` +
            `dims=${fact.derivedMediaDimensions ?? "n/a"} request=${fact.derivedMediaRequestDigest ?? "n/a"}`,
        );
      }
      for (const boundary of notRun) {
        console.warn(`[VAL-018] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL platform execution must have been driven —
      // the wrong-modality row is credential-free by design (a REAL
      // platform execution completing FAILED with ZERO provider
      // dispatches); with any credential present the chain rows drive
      // REAL dispatches. Never an all-NOT-RUN silent pass.
      expect(runFacts.length).toBeGreaterThan(0);
      if (visionOk && derivedOk) {
        expect(completed).toBeGreaterThan(0);
      }
    } finally {
      await world.server.app.close();
    }
  });
});
