/**
 * Synthesis service (tools module application; WORK-018, TOL-004).
 *
 * THE governed lifecycle of program synthesis. Every phase is durable,
 * idempotent and evidence-producing; every execution goes through the
 * sandbox manager; nothing here is a second authority:
 *
 * ```text
 * submitProgram      → fail-closed request validation (shape, secret
 *                      scan, full tool-contract validation, synth-
 *                      identity, expiry) → durable draft row
 *                      (content-addressed digest; idempotent insert)
 * compileProgram     → static validation (the v1 language subset scan
 *                      + revalidation) → draft→validated or →rejected
 * testProgram        → runtime tests, EACH executed through the
 *                      REQUIRED SynthesisSandboxExecutor →
 *                      validated→usable or →rejected (per-case
 *                      evidence: sandbox identity, digests, verdict)
 * bindTool           → usable + unexpired → register into THE tool
 *                      registry (the same registry, the same runtime
 *                      admission chain — policy → budget →
 *                      capability — governs every later invocation;
 *                      synthesized code cannot obtain capabilities
 *                      beyond policy grants because there is no other
 *                      path)
 * retireProgram      → usable→retired (terminal eviction)
 * ```
 *
 * Crash safety (the §14 discipline): each phase is a separate guarded
 * durable transition; a crash between phases leaves the honest
 * earlier state; replays converge on the committed row
 * (`INVALID_STATE_TRANSITION` surfaces disagreement; the caller
 * re-reads). No phase fabricates evidence: `usable` is reachable ONLY
 * through per-case sandbox execution identities.
 *
 * The dependency surface is PINNED (the learning-service discipline):
 * {store, sandbox executor, registry, adapter factory, digest,
 * generateId, now} — no policy seam, no budget seam, no capability
 * seam, no execution-transition seam is reachable from here because
 * admission happens in THEIR authorities: the tool runtime at
 * invocation time and the sandbox service at execution time.
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type { SynthesizedProgramRecord } from "../domain/synthesis";
import {
  canonicalOutputJson,
  canonicalSynthesisJson,
  parseSynthesizedOutput,
  SYNTHESIS_KEY_PATTERN,
  scanLanguageSubset,
  synthesisSubmissionFingerprint,
  validateSynthesisRequest,
} from "../domain/synthesis";
import type { SynthesizedToolAdapterFactory } from "../ports/synthesis-adapter-factory";
import type {
  SynthesisSandboxDispatch,
  SynthesisSandboxExecutor,
} from "../ports/synthesis-sandbox";
import type { SynthesisStore } from "../ports/synthesis-store";
import type { RegisterToolOutcome, ToolRegistry } from "../ports/tool-registry";

/** The v1 default dispatch deadline for synthesized-tool invocations. */
export const SYNTHESIS_DEFAULT_TIMEOUT_MS = 30_000;

export interface SynthesisServiceDeps {
  readonly store: SynthesisStore;
  /** REQUIRED — the ONLY execution surface (compile/run inside the sandbox). */
  readonly sandbox: SynthesisSandboxExecutor;
  /** THE tool registry — binding target (the governed runtime's registry). */
  readonly registry: ToolRegistry;
  /** Constructs the sandbox-dispatching adapter for a usable program. */
  readonly adapterFactory: SynthesizedToolAdapterFactory;
  /** Content-addressing digest (canonical JSON → hash). */
  readonly digest: (canonical: string) => string;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export type SubmitProgramOutcome =
  | { readonly status: "submitted"; readonly program: SynthesizedProgramRecord }
  | { readonly status: "converged"; readonly program: SynthesizedProgramRecord }
  | { readonly status: "rejected"; readonly reason: string };

export interface SynthesisActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface SynthesisService {
  submitProgram(
    request: unknown,
    idempotencyKey: string,
    actor: SynthesisActor,
  ): Promise<SubmitProgramOutcome>;
  compileProgram(programId: string, actor: SynthesisActor): Promise<SynthesizedProgramRecord>;
  /**
   * Run the runtime tests through the sandbox manager. `executionId` is
   * the PARENT execution the test runs bind to (execution provenance —
   * every synthesized-program execution is a governed sandbox execution
   * under a real execution identity; the sandbox service enforces the
   * binding).
   */
  testProgram(
    programId: string,
    actor: SynthesisActor,
    executionId: string,
  ): Promise<SynthesizedProgramRecord>;
  bindTool(
    programId: string,
    actor: SynthesisActor,
    timeoutMs?: number,
  ): Promise<RegisterToolOutcome>;
  retireProgram(programId: string, actor: SynthesisActor): Promise<SynthesizedProgramRecord>;
  getProgram(applicationId: string, programId: string): Promise<SynthesizedProgramRecord | null>;
  listPrograms(applicationId: string): Promise<readonly SynthesizedProgramRecord[]>;
  /** The neutral fact projection of usable, unexpired synthesized tools. */
  synthesizedFacts(applicationId: string): Promise<readonly unknown[]>;
}

function requireUuid(value: string, field: string): string {
  if (!isUuid(value)) {
    throw new PlatformError({ code: "TOOL_ERROR", message: `${field} must be a UUID` });
  }
  return value;
}

export function createSynthesisService(deps: SynthesisServiceDeps): SynthesisService {
  const { store, sandbox, registry, adapterFactory, digest, generateId, now } = deps;

  async function loadProgram(
    applicationId: string,
    programId: string,
    actor: SynthesisActor,
  ): Promise<SynthesizedProgramRecord> {
    requireUuid(applicationId, "applicationId");
    requireUuid(programId, "programId");
    const program = await store.get(applicationId, programId);
    if (program === null) {
      throw new PlatformError({
        code: "TOOL_ERROR",
        message: `synthesized program ${programId} not found in application ${applicationId}`,
      });
    }
    if (program.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "synthesized program belongs to another tenant",
      });
    }
    return program;
  }

  function assertUnexpired(program: SynthesizedProgramRecord): void {
    if (now().toISOString() >= program.expiresAt) {
      throw new PlatformError({
        code: "EXPIRED",
        message: `synthesized program ${program.toolId} expired at ${program.expiresAt}; ephemeral programs cannot be used past expiry`,
      });
    }
  }

  return {
    async submitProgram(request, idempotencyKey, actor) {
      requireUuid(actor.applicationId, "applicationId");
      if (typeof idempotencyKey !== "string" || !SYNTHESIS_KEY_PATTERN.test(idempotencyKey)) {
        throw new PlatformError({
          code: "TOOL_ERROR",
          message: "idempotencyKey must be a non-empty printable string (max 200 chars)",
        });
      }
      const validation = validateSynthesisRequest(request);
      if (!validation.valid) {
        // Malformed submissions are rejected BEFORE anything durable —
        // no journal row, the executions/tools precedent for
        // request-validation failures.
        return { status: "rejected", reason: validation.reason };
      }
      const r = request as import("../domain/synthesis").SynthesisRequest;
      if (now().toISOString() >= r.expiresAt) {
        return { status: "rejected", reason: "expiresAt must be in the future" };
      }
      const sourceDigest = digest(canonicalSynthesisJson(r));
      const fingerprint = synthesisSubmissionFingerprint(actor.applicationId, r);
      const program: SynthesizedProgramRecord = {
        id: generateId(),
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        toolId: r.contract.toolId,
        version: r.contract.version,
        language: r.language,
        source: r.source,
        sourceDigest,
        contract: r.contract,
        testCases: r.testCases,
        status: "draft",
        staticValidation: null,
        runtimeTests: null,
        rejection: null,
        expiresAt: r.expiresAt,
        submittedBy: actor.actorId,
        submissionIdempotencyKey: idempotencyKey,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
      };
      const inserted = await store.insert({ program, submissionFingerprint: fingerprint });
      return inserted.status === "converged"
        ? { status: "converged", program: inserted.program }
        : { status: "submitted", program: inserted.program };
    },

    async compileProgram(programId, actor) {
      const program = await loadProgram(actor.applicationId, programId, actor);
      if (program.status !== "draft") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `program ${program.toolId} is ${program.status}; compilation requires draft (replay converges on the committed state)`,
        });
      }
      // Static validation over the STORED record (never the caller's
      // re-assertion): full request revalidation + the v1 language
      // subset scan. Fail-closed at every dimension.
      const revalidation = validateSynthesisRequest({
        source: program.source,
        language: program.language,
        contract: program.contract,
        testCases: program.testCases,
        expiresAt: program.expiresAt,
      });
      const subset = scanLanguageSubset(program.source);
      const staticReason = !revalidation.valid
        ? revalidation.reason
        : !subset.valid
          ? subset.reason
          : null;
      if (staticReason !== null) {
        return store.transition({
          applicationId: actor.applicationId,
          programId,
          from: "draft",
          to: "rejected",
          rejection: {
            phase: "static-validation",
            reason: staticReason,
            at: now().toISOString(),
          },
        });
      }
      return store.transition({
        applicationId: actor.applicationId,
        programId,
        from: "draft",
        to: "validated",
        staticValidation: {
          language: program.language,
          sourceDigest: program.sourceDigest,
          checks: [
            "source-bounds",
            "raw-secret-scan",
            "tool-contract-validation",
            "synth-identity-prefix",
            "language-vocabulary",
            "test-case-shapes",
            "v1-language-subset",
          ],
          validatedAt: now().toISOString(),
        },
      });
    },

    async testProgram(programId, actor, executionId) {
      requireUuid(executionId, "executionId");
      const program = await loadProgram(actor.applicationId, programId, actor);
      if (program.status === "usable") {
        // Replay convergence: the committed usable row IS the answer.
        return program;
      }
      if (program.status === "rejected" || program.status === "retired") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `program ${program.toolId} is ${program.status} (terminal)`,
        });
      }
      if (program.status !== "validated") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `program ${program.toolId} is ${program.status}; runtime tests require validated`,
        });
      }
      assertUnexpired(program);
      const cases = program.testCases;
      if (cases.length === 0) {
        throw new PlatformError({
          code: "TOOL_ERROR",
          message:
            "the program record carries no runtime test cases (unrepresentable — submission validates them)",
        });
      }
      const evidence: import("../domain/synthesis").SynthesisTestCaseEvidence[] = [];
      let passed = true;
      for (const testCase of cases) {
        const dispatch: SynthesisSandboxDispatch = {
          program: {
            toolId: program.toolId,
            version: program.version,
            sourceDigest: program.sourceDigest,
            source: program.source,
          },
          contract: program.contract,
          input: testCase.input,
          actor,
          executionId,
          idempotencyKey: `synth-test:${program.id}:${testCase.name}`,
          timeoutMs: SYNTHESIS_DEFAULT_TIMEOUT_MS,
        };
        let result: import("../ports/synthesis-sandbox").SynthesisSandboxResult;
        try {
          result = await sandbox.execute(dispatch);
        } catch (error) {
          // Executor REFUSALS (fail-closed PlatformErrors — e.g. the
          // substrate confinement check) are durable per-case failures:
          // the program can never pass a gate it cannot even run.
          result = {
            outcome: "failure",
            failureClass: "admission-refused",
            message: error instanceof Error ? error.message : String(error),
            sandboxId: null,
          };
        }
        if (result.outcome === "failure") {
          passed = false;
          evidence.push({
            name: testCase.name,
            status: "failed",
            sandboxId: result.sandboxId,
            expectedDigest: digest(canonicalOutputJson(testCase.expectedOutput)),
            actualDigest: null,
            message: result.message,
            finishedAt: now().toISOString(),
          });
          continue;
        }
        const parsed = parseSynthesizedOutput(result.stdout);
        if (!parsed.ok) {
          passed = false;
          evidence.push({
            name: testCase.name,
            status: "failed",
            sandboxId: result.sandboxId,
            expectedDigest: digest(canonicalOutputJson(testCase.expectedOutput)),
            actualDigest: result.outputDigest,
            message: parsed.reason,
            finishedAt: now().toISOString(),
          });
          continue;
        }
        const actual = canonicalOutputJson(parsed.output);
        const expected = canonicalOutputJson(testCase.expectedOutput);
        const matches = actual === expected;
        if (!matches) {
          passed = false;
        }
        evidence.push({
          name: testCase.name,
          status: matches ? "passed" : "failed",
          sandboxId: result.sandboxId,
          expectedDigest: digest(expected),
          actualDigest: digest(actual),
          message: matches ? null : "the program output did not match the declared expected output",
          finishedAt: now().toISOString(),
        });
      }
      return store.transition({
        applicationId: actor.applicationId,
        programId,
        from: "validated",
        to: passed ? "usable" : "rejected",
        ...(passed
          ? {
              runtimeTests: {
                cases: evidence,
                passed: true,
                ranAt: now().toISOString(),
              },
            }
          : {
              runtimeTests: {
                cases: evidence,
                passed: false,
                ranAt: now().toISOString(),
              },
              rejection: {
                phase: "runtime-tests" as const,
                reason: "one or more runtime test cases failed (see per-case evidence)",
                at: now().toISOString(),
              },
            }),
      });
    },

    async bindTool(programId, actor, timeoutMs = SYNTHESIS_DEFAULT_TIMEOUT_MS) {
      const program = await loadProgram(actor.applicationId, programId, actor);
      if (program.status !== "usable") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `program ${program.toolId} is ${program.status}; only usable programs can be bound as tools`,
        });
      }
      assertUnexpired(program);
      const adapter = adapterFactory.create(program, timeoutMs);
      return registry.register(program.contract, adapter);
    },

    async retireProgram(programId, actor) {
      const program = await loadProgram(actor.applicationId, programId, actor);
      if (program.status !== "usable") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `program ${program.toolId} is ${program.status}; retirement requires usable`,
        });
      }
      return store.transition({
        applicationId: actor.applicationId,
        programId,
        from: "usable",
        to: "retired",
      });
    },

    async getProgram(applicationId, programId) {
      requireUuid(applicationId, "applicationId");
      requireUuid(programId, "programId");
      return store.get(applicationId, programId);
    },

    async listPrograms(applicationId) {
      requireUuid(applicationId, "applicationId");
      return store.listByApplication(applicationId);
    },

    async synthesizedFacts(applicationId) {
      requireUuid(applicationId, "applicationId");
      const usable = await store.listUsable(applicationId, now());
      return usable
        .filter((program) => now().toISOString() < program.expiresAt)
        .map((program) => ({
          toolId: program.toolId,
          version: program.version,
          capabilityIds: [program.contract.capability.id],
          inputFields: program.contract.inputSchema.fields.map((field) => ({
            name: field.name,
            type: field.type,
            required: field.required,
          })),
          outputFields: program.contract.outputSchema.fields.map((field) => ({
            name: field.name,
            type: field.type,
            required: field.required,
          })),
          origin: "synthesized" as const,
          sourceDigest: program.sourceDigest,
        }));
    },
  };
}
