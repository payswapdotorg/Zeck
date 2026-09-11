/**
 * VAL-002 acceptance criteria 1 and 7 — the crown proof: the sample
 * application invokes Zeck through the REAL public integration
 * boundary. The REAL Fastify API server is served over the REAL SQL
 * authorities (seeded PostgreSQL world) on a real port; the application
 * rides the public SDK client through a real transport — exactly the
 * path a customer integrates through. The platform side drives the
 * canonical lifecycle (the seeded world plays Zeck's operators); the
 * application itself only submits, polls, retrieves and asserts.
 */

import { expect, test } from "vitest";
import { runSampleApp } from "../../../benchmarks/validation/apps/sample/application";
import type { AppHarnessConfig } from "../../../benchmarks/validation/harness";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import { seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite } from "../postgres/harness";

definePgSuite("validation harness over the real public API (VAL-002)", (ctx) => {
  test("the sample application completes end to end through the public SDK boundary", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const config: AppHarnessConfig = {
        applicationId: world.applicationId,
        baseUrl: address,
        tokenEnvVar: "ZECK_VALIDATION_TOKEN",
        applicationRevision: "90ceeddd1c6e5553254eaaade3155be391670787",
        corpusRevision: "90ceeddd1c6e5553254eaaade3155be391670787",
        integrationSurface: "sdk",
        pollIntervalMs: 10,
        completionTimeoutMs: 15000,
      };

      const submitted: { id: string | null } = { id: null };
      const appPromise = runSampleApp({
        config,
        token: world.bearerToken,
        transport: globalThis.fetch,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        environment: {
          runtime: `node ${process.version}`,
          toolchain: "vitest",
          database: "postgresql",
          configuration: { mode: "integration" },
        },
        runSuffix: `${Date.now()}`,
      });

      // Drive the canonical lifecycle platform-side until the app's
      // execution reaches COMPLETED. The app polls concurrently.
      const scope = {
        actorId: world.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
      };
      const drive = async (): Promise<void> => {
        // Wait for the app's submission to land.
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const rows = await ctx.port.execute<{ id: string }>({
            sql: `SELECT id FROM executions.executions WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1`,
            parameters: [world.applicationId],
          });
          const execution = rows.rows[0];
          if (execution !== undefined) {
            submitted.id = execution.id;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const executionId = submitted.id;
        expect(executionId).not.toBeNull();
        for (const command of ["authorize", "plan", "queue", "start", "verify"] as const) {
          await world.executions.transition(
            {
              ...scope,
              executionId: executionId as string,
              command,
              reason: `validation-${command}`,
            },
            `val-002-${command}-${executionId}`,
          );
        }
        await world.executions.transition(
          {
            ...scope,
            executionId: executionId as string,
            command: "pass",
            reason: "validation-pass",
            verificationResults: [
              {
                criterionId: "val-002-sample",
                strategy: "deterministic",
                status: "PASS",
                recordedBy: "validation-harness",
              },
            ],
          },
          `val-002-pass-${executionId}`,
        );
      };

      const [, outcome] = await Promise.all([drive(), appPromise]);
      expect(outcome.passed).toBe(true);
      const violations = validateHarnessEvidence(outcome.evidence);
      expect(violations).toEqual([]);
      expect(outcome.evidence.terminalStatus).toBe("COMPLETED");
      expect(outcome.evidence.verificationStatuses).toContain("PASS");
      expect(outcome.evidence.request?.taskKind).toBe("summarize");
      expect(outcome.evidence.timings.submitMs).not.toBeNull();
      expect(outcome.evidence.timings.completionMs).not.toBeNull();
      expect(outcome.evidence.timings.retrievalMs).not.toBeNull();
    } finally {
      await world.server.app.close();
    }
  });

  test("error reporting over the real boundary: unknown execution retrieval surfaces 404 (AC2)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const harnessOutcome = await runSampleApp({
        config: {
          applicationId: world.applicationId,
          baseUrl: address,
          tokenEnvVar: "ZECK_VALIDATION_TOKEN",
          applicationRevision: "90ceeddd1c6e5553254eaaade3155be391670787",
          corpusRevision: "90ceeddd1c6e5553254eaaade3155be391670787",
          integrationSurface: "sdk",
          pollIntervalMs: 10,
          completionTimeoutMs: 3000,
        },
        token: world.bearerToken,
        transport: (async (input: unknown, init?: unknown) => {
          const url = String(input);
          if (url.includes("/executions/") && url.endsWith("/results")) {
            // force the error-reporting path deterministically
            return new Response(
              JSON.stringify({
                code: "NOT_FOUND",
                message: "execution result unavailable",
                retryable: false,
              }),
              { status: 404, headers: { "content-type": "application/json" } },
            );
          }
          return globalThis.fetch(
            input as Parameters<typeof globalThis.fetch>[0],
            init as Parameters<typeof globalThis.fetch>[1],
          );
        }) as typeof fetch,
        now: () => new Date(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        environment: {
          runtime: `node ${process.version}`,
          toolchain: "vitest",
          database: "postgresql",
          configuration: {},
        },
        runSuffix: `err-${Date.now()}`,
      });

      // The submission and completion still ride the real boundary; the
      // retrieval failure surfaces as a recorded 404 in the evidence and
      // the deterministic assertions fail the run (COMPLETED expected,
      // verification evidence unavailable).
      const evidence = harnessOutcome.evidence;
      expect(evidence.errors.some((error) => error.status === 404)).toBe(true);
      expect(harnessOutcome.passed).toBe(false);
      expect(validateHarnessEvidence(evidence)).toEqual([]);
    } finally {
      await world.server.app.close();
    }
  });
});
