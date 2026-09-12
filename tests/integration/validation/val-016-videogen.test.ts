/**
 * VAL-016 acceptance criteria 3, 4, 5, 7 — the crown proof: the two
 * videogen customer applications (video-generation AND
 * media-generation-jobs) run end to end against the REAL platform
 * path with REAL async video-model dispatches.
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port;
 *   - the REAL executions lifecycle (canonical transitions + durable
 *     planning decision recorded BEFORE the dispatch) driven
 *     platform-side exactly as Zeck's operators would;
 *   - the REAL dashscope-international video-synthesis ASYNC task
 *     rail for wan2.2-t2v-plus (submission with the async header
 *     `X-DashScope-Async: enable` → task identity → bounded polling →
 *     terminal artifact fetch) — the credential is materialized from
 *     the environment at run time, never in the repository;
 *   - the REAL mechanical verification criteria recorded on the
 *     execution ledger (MP4 `ftyp` container validity, declared
 *     byte-size bounds, canonical sha256 digest capture — plus the
 *     rail-reported duration/dimension bounds where the rail reports
 *     them); the applications assert the verified outcomes;
 *   - the REAL async JOB semantics for the media-generation-jobs
 *     application: every submitted item driven, polled, retrieved and
 *     accounted (no lost tasks), with honest task-failure propagation
 *     (the zero-duration edge item FAILS the job while its healthy
 *     sibling completes);
 *   - honest async economics: submission-to-terminal wall time, poll
 *     counts and cadence, dispatch latency and provider usage are
 *     MEASURED (never estimated); evidence carries payload DIGESTS,
 *     never payloads.
 *
 * The provider credential is environment-gated: an absent QWEN_API_KEY
 * makes the REAL videogen runs a NOT RUN boundary (recorded honestly;
 * never a silent pass). The PostgreSQL suite is likewise skipped
 * without ZECK_PG_TEST_URL (the harness's own gate).
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  type MediaJobRunOutcome,
  runMediaGenerationJobsApp,
} from "../../../benchmarks/validation/apps/media-generation-jobs/application";
import { MEDIA_GENERATION_JOBS } from "../../../benchmarks/validation/apps/media-generation-jobs/jobs";
import {
  runVideoGenerationApp,
  VIDEO_GENERATION_TASKS,
} from "../../../benchmarks/validation/apps/video-generation/application";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import {
  createDashscopeVideogenRail,
  createVideogenDispatchBinding,
  driveVideogenExecution,
  type GenerateVideoTask,
  type HttpTransport,
  type VideogenRunResult,
} from "../../../benchmarks/validation/platform/videogen";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite } from "../postgres/harness";

const QWEN_KEY = process.env.QWEN_API_KEY ?? "";
const VIDEOGEN_PROVIDER = "dashscope";
const VIDEOGEN_MODEL = process.env.ZECK_VAL_016_VIDEO_MODEL ?? "wan2.2-t2v-plus";

/**
 * Per-row expected terminals (the corpus rows'/apps' own expectations):
 * healthy rows COMPLETED; the zero-seconds edge row FAILED (rejected
 * before any paid dispatch). Jobs: all-healthy → COMPLETED; the job
 * carrying the edge item → FAILED (honest task-failure propagation).
 */
const EXPECTED_TERMINALS: Record<string, "COMPLETED" | "FAILED"> = {
  "video-generation#0": "COMPLETED",
  "video-generation#1": "COMPLETED",
  "video-generation#2": "COMPLETED",
  "video-generation#3": "FAILED",
  "media-job-001": "COMPLETED",
  "media-job-002": "FAILED",
};

/** One driven execution's REAL facts (matched to its submitting row). */
interface DrivenExecution {
  readonly executionId: string;
  readonly fixtureKey: string;
  readonly platform: VideogenRunResult;
}

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly app: "video-generation" | "media-generation-jobs";
  readonly rowKey: string;
  readonly fixtureKey: string;
  readonly terminal: string;
  readonly criteria: readonly { criterionId: string; status: string }[];
  /** Filled by the caller after the app-side assertion result is known. */
  appPassed: boolean;
  /** Filled by the caller after the evidence validation ran. */
  evidenceViolations: number;
  readonly usage: { inputTokens: number; outputTokens: number } | null;
  readonly dispatchLatencyMs: number | null;
  readonly submissionToTerminalMs: number | null;
  readonly polls: number | null;
  readonly videoDigest: string | null;
  readonly videoByteLength: number | null;
  readonly videoContainer: string | null;
  readonly taskId: string | null;
  readonly requestDigest: string | null;
  readonly failureCategory: string | null;
}

/** Job-level REAL facts (the async job semantics). */
interface JobFacts {
  readonly jobId: string;
  readonly jobTerminal: string;
  readonly expectedJobTerminal: string;
  readonly jobPassed: boolean;
  readonly completedItemCount: number;
  readonly failedItemCount: number;
  readonly lostItemCount: number;
  readonly jobWallMs: number;
  readonly pollObservations: number;
  readonly rows: readonly RunFacts[];
}

definePgSuite(
  "VAL-016 videogen applications over the real platform path (REAL provider)",
  (ctx) => {
    test("video-generation and media-generation-jobs applications complete end to end", {
      timeout: 3_600_000,
    }, async () => {
      if (QWEN_KEY.length === 0) {
        console.warn(
          "[VAL-016] QWEN_API_KEY absent — the REAL videogen runs (ALL rows of BOTH " +
            "applications: video-generation rows 0..3 AND media-generation-jobs items of " +
            "media-job-001/media-job-002, all riding the dashscope-international " +
            "video-synthesis async task rail for " +
            VIDEOGEN_MODEL +
            ") are a NOT RUN " +
            "boundary (recorded honestly in docs/work-items/VAL-016.md; no fake success " +
            "is asserted).",
        );
        expect(true).toBe(true);
        return;
      }

      const generateId = createUuidv7Generator();
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });

      // ---- The REAL videogen rail (production fetch transport) ----
      const realFetch: HttpTransport = (url, init) => fetch(url, init);
      const rail = createDashscopeVideogenRail({
        transport: realFetch,
        apiKey: QWEN_KEY,
        timeoutMs: 240_000, // bounded per attempt: 48 polls at 5s
        pollIntervalMs: 5_000,
      });
      // The platform's bounded retry policy: RETRYABLE provider failures
      // (rate limits, transient unavailability, budget-exhausted
      // generations) get ONE additional REAL attempt; non-retryable
      // failures (the zero-duration edge row, auth, digest mismatches,
      // failed provider tasks) are never retried. Waits are part of the
      // measured dispatch latency.
      const dispatch = createVideogenDispatchBinding({
        rail,
        retry: { attempts: 1, delayMs: 10_000 },
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
            `val-016-${executionId}-${step}`,
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
                    strategyId: "val-016-pinned",
                    plan: {
                      strategyClass: route.strategyClass,
                      modelCalls: 1,
                      steps: [{ routeRef: { provider: route.provider, model: route.model } }],
                    },
                  },
                ],
                selectedStrategyId: "val-016-pinned",
              },
            },
            `val-016-${executionId}-decision`,
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
                recordedBy: "val-016-platform",
                evidence: [...criterion.evidence],
              })),
            },
            `val-016-${executionId}-${verdict}`,
          );
        },
      };

      // ---- The interleaved platform driver: drive every execution as it lands ----
      const drivenExecutionIds = new Set<string>();

      async function pollForNewExecutions(): Promise<
        readonly { readonly id: string; readonly task: GenerateVideoTask }[]
      > {
        const rows = await ctx.port.execute<{ id: string; task: GenerateVideoTask }>({
          sql: "SELECT id, task FROM executions.executions WHERE application_id = $1 ORDER BY created_at ASC",
          parameters: [world.applicationId],
        });
        const landed: { id: string; task: GenerateVideoTask }[] = [];
        for (const row of rows.rows) {
          if (!drivenExecutionIds.has(row.id)) {
            drivenExecutionIds.add(row.id);
            landed.push({ id: row.id, task: row.task });
          }
        }
        return landed;
      }

      /**
       * Run one app (single task or whole job) while the platform-side
       * driver picks up every execution the app submits, exactly as
       * Zeck's operators would, and drives it through the REAL rail.
       * The loop ends only when the app has settled AND no execution
       * remains undriven (no lost tasks).
       */
      async function runWithPlatformDriving<T>(
        start: () => Promise<T>,
      ): Promise<{ readonly outcome: T; readonly driven: readonly DrivenExecution[] }> {
        let settled = false;
        let captured: T | undefined;
        let capturedError: unknown;
        const appPromise = start().then(
          (value) => {
            settled = true;
            captured = value;
          },
          (error: unknown) => {
            settled = true;
            capturedError = error;
          },
        );
        const driven: DrivenExecution[] = [];
        for (;;) {
          const landed = await pollForNewExecutions();
          for (const execution of landed) {
            const platform = await driveVideogenExecution({
              executionId: execution.id,
              task: execution.task,
              provider: VIDEOGEN_PROVIDER,
              model: VIDEOGEN_MODEL,
              ports: { lifecycle, dispatch, now: () => new Date() },
            });
            driven.push({
              executionId: execution.id,
              fixtureKey: execution.task.prompt === "" ? "(empty prompt)" : execution.task.prompt,
              platform,
            });
            console.info(
              `[VAL-016]   drove ${execution.id.slice(0, 8)} (${execution.task.prompt}) -> ` +
                `${platform.terminal} [${platform.criteria.map((c) => `${c.criterionId}:${c.status}`).join(", ")}] ` +
                `taskId=${platform.taskId ?? "none"} polls=${platform.polls ?? 0} ` +
                `asyncWall=${platform.submissionToTerminalMs ?? "n/a"}ms ` +
                `digest=${platform.videoDigest ?? "n/a"}`,
            );
          }
          if (settled && landed.length === 0) {
            break;
          }
          if (!settled) {
            await Promise.race([appPromise, new Promise((resolve) => setTimeout(resolve, 25))]);
          }
        }
        await appPromise;
        if (capturedError !== undefined || captured === undefined) {
          throw capturedError ?? new Error("the application run produced no outcome");
        }
        return { outcome: captured, driven };
      }

      const runFacts: RunFacts[] = [];
      const jobFacts: JobFacts[] = [];

      const factsOf = (
        app: RunFacts["app"],
        rowKey: string,
        driven: DrivenExecution,
        appPassed: boolean,
        evidenceViolations: number,
      ): RunFacts => ({
        app,
        rowKey,
        fixtureKey: driven.fixtureKey,
        terminal: driven.platform.terminal,
        criteria: driven.platform.criteria.map((c) => ({
          criterionId: c.criterionId,
          status: c.status,
        })),
        appPassed,
        evidenceViolations,
        usage:
          driven.platform.usage === null
            ? null
            : {
                inputTokens: driven.platform.usage.inputTokens,
                outputTokens: driven.platform.usage.outputTokens,
              },
        dispatchLatencyMs: driven.platform.dispatchLatencyMs,
        submissionToTerminalMs: driven.platform.submissionToTerminalMs,
        polls: driven.platform.polls,
        videoDigest: driven.platform.videoDigest,
        videoByteLength: driven.platform.videoByteLength,
        videoContainer: driven.platform.videoContainer,
        taskId: driven.platform.taskId,
        requestDigest: driven.platform.requestDigest,
        failureCategory: driven.platform.failureCategory,
      });

      /** The honest outcome contract (mechanically checkable per row). */
      const assertRow = (facts: RunFacts, expectedTerminal: "COMPLETED" | "FAILED"): void => {
        expect(facts.evidenceViolations).toBe(0);
        const anyFail = facts.criteria.some((c) => c.status === "FAIL");
        expect(facts.terminal).toBe(anyFail ? "FAILED" : "COMPLETED");
        expect(facts.terminal).toBe(expectedTerminal);
        expect(facts.appPassed).toBe(true);
        if (expectedTerminal === "COMPLETED") {
          expect(facts.criteria.every((c) => c.status === "PASS")).toBe(true);
          expect(facts.videoDigest).not.toBeNull();
          expect(facts.videoDigest).toMatch(/^[0-9a-f]{16}$/);
          expect(facts.videoContainer).toBe("mp4");
          expect(facts.videoByteLength).not.toBeNull();
          expect(facts.videoByteLength as number).toBeGreaterThanOrEqual(1024);
          expect(facts.taskId).not.toBeNull();
          expect(facts.polls).not.toBeNull();
          expect(facts.polls as number).toBeGreaterThanOrEqual(1); // polling genuinely happened
          expect(facts.submissionToTerminalMs).not.toBeNull();
          expect(facts.submissionToTerminalMs as number).toBeGreaterThan(0); // async wall measured
          expect(facts.requestDigest).not.toBeNull();
          if (facts.usage !== null) {
            expect(facts.usage.outputTokens).toBeGreaterThan(0); // honest usage, never estimated
          }
        } else {
          // The honest failure path: the zero-duration edge row is
          // rejected BEFORE any paid dispatch.
          expect(facts.failureCategory).toBe("invalid-request");
          expect(facts.taskId).toBeNull();
          expect(facts.polls).toBe(0);
          expect(facts.videoDigest).toBeNull();
        }
      };

      try {
        // ---- The video-generation application (one execution per row) ----
        for (const [taskIndex] of VIDEO_GENERATION_TASKS.entries()) {
          // Provider-side pacing: a modest spacing between REAL dispatches.
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const rowKey = `video-generation#${taskIndex}`;
          const expectedTerminal = EXPECTED_TERMINALS[rowKey] ?? "COMPLETED";
          const runSuffix = `it-${generateId().slice(-8)}`;
          const { outcome, driven } = await runWithPlatformDriving(() =>
            runVideoGenerationApp({
              config: {
                applicationId: world.applicationId,
                baseUrl: address,
                tokenEnvVar: "ZECK_VALIDATION_TOKEN",
                applicationRevision: createHash("sha256")
                  .update(`${VIDEOGEN_PROVIDER}|${VIDEOGEN_MODEL}|val-016-pinned`)
                  .digest("hex")
                  .slice(0, 40),
                corpusRevision: createHash("sha256")
                  .update(`${VIDEOGEN_PROVIDER}|${VIDEOGEN_MODEL}|val-016-pinned`)
                  .digest("hex")
                  .slice(0, 40),
                integrationSurface: "sdk",
                pollIntervalMs: 250,
                completionTimeoutMs: 520_000,
              },
              token: world.bearerToken,
              transport: globalThis.fetch,
              now: () => new Date(),
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              environment: {
                runtime: `node ${process.version}`,
                toolchain: "vitest",
                database: "postgresql",
                configuration: { suite: "val-016-videogen" },
              },
              runSuffix,
              taskIndex,
            }),
          );
          expect(driven).toHaveLength(1);
          const evidenceViolations = validateHarnessEvidence(outcome.evidence);
          const facts = factsOf(
            "video-generation",
            rowKey,
            driven[0] as DrivenExecution,
            outcome.passed,
            evidenceViolations.length,
          );
          expect(evidenceViolations).toEqual([]);
          runFacts.push(facts);
          console.info(
            `[VAL-016] ${rowKey} (${facts.fixtureKey}) -> ${facts.terminal} ` +
              `[${facts.criteria.map((c) => `${c.criterionId}:${c.status}`).join(", ")}] ` +
              `usage=${facts.usage === null ? "n/a" : `${facts.usage.inputTokens}+${facts.usage.outputTokens}`} ` +
              `latency=${facts.dispatchLatencyMs}ms asyncWall=${facts.submissionToTerminalMs}ms ` +
              `polls=${facts.polls} video=${facts.videoDigest ?? "n/a"} ` +
              `bytes=${facts.videoByteLength ?? "n/a"} request=${facts.requestDigest ?? "n/a"}`,
          );
          assertRow(facts, expectedTerminal);
        }

        // ---- The media-generation-jobs application (one execution per item) ----
        for (const [jobIndex, job] of MEDIA_GENERATION_JOBS.entries()) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const expectedJobTerminal = EXPECTED_TERMINALS[job.jobId] ?? "COMPLETED";
          const runSuffix = `it-${generateId().slice(-8)}`;
          const { outcome, driven } = await runWithPlatformDriving(() =>
            runMediaGenerationJobsApp({
              config: {
                applicationId: world.applicationId,
                baseUrl: address,
                tokenEnvVar: "ZECK_VALIDATION_TOKEN",
                applicationRevision: createHash("sha256")
                  .update(`${VIDEOGEN_PROVIDER}|${VIDEOGEN_MODEL}|val-016-pinned`)
                  .digest("hex")
                  .slice(0, 40),
                corpusRevision: createHash("sha256")
                  .update(`${VIDEOGEN_PROVIDER}|${VIDEOGEN_MODEL}|val-016-pinned`)
                  .digest("hex")
                  .slice(0, 40),
                integrationSurface: "sdk",
                pollIntervalMs: 250,
                completionTimeoutMs: 520_000,
              },
              token: world.bearerToken,
              transport: globalThis.fetch,
              now: () => new Date(),
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
              environment: {
                runtime: `node ${process.version}`,
                toolchain: "vitest",
                database: "postgresql",
                configuration: { suite: "val-016-videogen" },
              },
              runSuffix,
              jobIndex,
            }),
          );
          const jobOutcome: MediaJobRunOutcome = outcome;

          // The async job semantics: EVERY item submitted was driven
          // (no lost tasks platform-side) and accounted app-side.
          expect(driven).toHaveLength(job.items.length);
          expect(jobOutcome.items).toHaveLength(job.items.length);

          const rows: RunFacts[] = [];
          for (const [itemIndex, item] of job.items.entries()) {
            const drivenItem = driven[itemIndex] as DrivenExecution;
            expect(drivenItem.fixtureKey).toBe(
              item.task.prompt === "" ? "(empty prompt)" : item.task.prompt,
            );
            const appItem = jobOutcome.items[itemIndex];
            const evidenceViolations = validateHarnessEvidence(appItem?.evidence as never);
            const facts = factsOf(
              "media-generation-jobs",
              `${job.jobId}#${item.itemKey}`,
              drivenItem,
              appItem?.assertionsPassed ?? false,
              evidenceViolations.length,
            );
            expect(evidenceViolations).toEqual([]);
            rows.push(facts);
            runFacts.push(facts);
            console.info(
              `[VAL-016] ${facts.rowKey} (${facts.fixtureKey}) -> ${facts.terminal} ` +
                `[${facts.criteria.map((c) => `${c.criterionId}:${c.status}`).join(", ")}] ` +
                `itemTerminal=${appItem?.terminalStatus ?? "LOST"} ` +
                `usage=${facts.usage === null ? "n/a" : `${facts.usage.inputTokens}+${facts.usage.outputTokens}`} ` +
                `latency=${facts.dispatchLatencyMs}ms asyncWall=${facts.submissionToTerminalMs}ms ` +
                `polls=${facts.polls} video=${facts.videoDigest ?? "n/a"} ` +
                `bytes=${facts.videoByteLength ?? "n/a"} request=${facts.requestDigest ?? "n/a"}`,
            );
            assertRow(facts, item.expectedItemTerminal);
          }

          // The job-level honest outcome contract.
          expect(jobOutcome.jobTerminal).toBe(jobOutcome.expectedJobTerminal);
          expect(jobOutcome.jobTerminal).toBe(expectedJobTerminal);
          expect(jobOutcome.jobPassed).toBe(true);
          expect(jobOutcome.lostItemCount).toBe(0); // no lost tasks, ever
          expect(jobOutcome.completedItemCount).toBe(
            job.items.filter((item) => item.expectedItemTerminal === "COMPLETED").length,
          );
          expect(jobOutcome.failedItemCount).toBe(
            job.items.filter((item) => item.expectedItemTerminal === "FAILED").length,
          );
          expect(jobOutcome.jobWallMs).toBeGreaterThan(0); // the async wall measured
          expect(jobOutcome.pollObservations).toBeGreaterThanOrEqual(job.items.length);

          jobFacts.push({
            jobId: job.jobId,
            jobTerminal: jobOutcome.jobTerminal,
            expectedJobTerminal: jobOutcome.expectedJobTerminal,
            jobPassed: jobOutcome.jobPassed,
            completedItemCount: jobOutcome.completedItemCount,
            failedItemCount: jobOutcome.failedItemCount,
            lostItemCount: jobOutcome.lostItemCount,
            jobWallMs: jobOutcome.jobWallMs,
            pollObservations: jobOutcome.pollObservations,
            rows,
          });
          console.info(
            `[VAL-016] ${job.jobId} -> job ${jobOutcome.jobTerminal} (expected ` +
              `${jobOutcome.expectedJobTerminal}) items=${jobOutcome.completedItemCount}C/` +
              `${jobOutcome.failedItemCount}F/${jobOutcome.lostItemCount}L ` +
              `jobWall=${jobOutcome.jobWallMs}ms polls=${jobOutcome.pollObservations}`,
          );
        }

        // ---- The REAL results summary (recorded in the evidence doc) ----
        const completed = runFacts.filter((f) => f.terminal === "COMPLETED").length;
        const failed = runFacts.filter((f) => f.terminal === "FAILED").length;
        const measuredClips = runFacts.reduce((sum, f) => sum + (f.usage?.outputTokens ?? 0), 0);
        const healthyRows = runFacts.filter((f) => f.terminal === "COMPLETED");
        const meanAsyncWall =
          healthyRows.length === 0
            ? 0
            : healthyRows.reduce((sum, f) => sum + (f.submissionToTerminalMs ?? 0), 0) /
              healthyRows.length;
        const totalPolls = healthyRows.reduce((sum, f) => sum + (f.polls ?? 0), 0);
        const meanPollCadenceMs = totalPolls === 0 ? 0 : Math.round(meanAsyncWall / totalPolls);
        const meanLatency =
          runFacts.length === 0
            ? 0
            : runFacts.reduce((sum, f) => sum + (f.dispatchLatencyMs ?? 0), 0) / runFacts.length;
        console.info(
          `[VAL-016] REAL run summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
            `of ${runFacts.length} driven executions across BOTH applications; measured clips ` +
            `${measuredClips} (usage video_count); mean submission-to-terminal async wall ` +
            `${Math.round(meanAsyncWall)}ms over ${totalPolls} bounded polls (cadence ~` +
            `${meanPollCadenceMs}ms); mean dispatch latency ${Math.round(meanLatency)}ms; ` +
            `${VIDEOGEN_MODEL} via ${VIDEOGEN_PROVIDER} (env-credential gated).`,
        );
        for (const job of jobFacts) {
          console.info(
            `[VAL-016] job ${job.jobId}: terminal=${job.jobTerminal} (expected ` +
              `${job.expectedJobTerminal}) passed=${job.jobPassed} items ` +
              `${job.completedItemCount}C/${job.failedItemCount}F/${job.lostItemCount}L ` +
              `jobWall=${job.jobWallMs}ms pollObservations=${job.pollObservations}`,
          );
        }
        // At least one REAL dispatch must have happened (never an
        // all-NOT-RUN silent pass) and every job must be accounted.
        expect(runFacts.length).toBeGreaterThan(0);
        expect(jobFacts).toHaveLength(MEDIA_GENERATION_JOBS.length);
      } finally {
        await world.server.app.close();
      }
    });
  },
);
