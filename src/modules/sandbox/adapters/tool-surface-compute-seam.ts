/**
 * Tool-surface compute-seam adapter (sandbox module adapter; WORK-051 —
 * THE only shipped implementation of the platform tool-surface plane's
 * `SandboxComputeSeam` port).
 *
 * Wraps the sandbox module's PUBLIC `SandboxService` +
 * `EnvironmentCatalog` exactly like the synthesis executor precedent
 * (WORK-018): every programmatic-execution run — fan-out, filter,
 * aggregate, projection — is a FULLY ADMITTED, DISPATCHED AND
 * JOURNALED sandbox execution (durable identity, the policy →
 * capability → budget admission chain, step-event provenance, bounded
 * output evidence, timeout enforcement). There is no other execution
 * surface for programmatic work anywhere in this module, and NO
 * second sandbox: the mechanical evaluation itself runs INSIDE the
 * dispatched sandbox process through a generic, bounded RUNNER
 * (adapter infrastructure, exactly like the synthesis INPUT_PRELUDE —
 * never user source).
 *
 * THE CROSSING (v1, honest against the frozen authority contracts):
 * the validated closed spec and the bounded input are embedded as
 * CONSTANTS inside ONE content-addressed runner script file under the
 * OS temp domain; the sandbox task names that file by its absolute
 * digest-pinned path. Why a file and not task argv (the synthesis
 * executor's `-e` form): the sandbox authority's frozen request
 * fingerprint (WORK-012, migration 0008) covers the WHOLE canonical
 * task and is bounded to 500 chars — a task carrying the runner +
 * payload (kilobytes of closed, validated data) is unrepresentable
 * durably. The content-addressed file keeps the durable task tiny
 * (ONE argument) while the digest-pinned path transitively records
 * EXACTLY which runner+payload content ran (the idempotency
 * fingerprint stays a pure function of the crossing CONTENT —
 * retries of the same logical request produce the identical task).
 * The adapter pre-checks the authority's fingerprint budget and fails
 * closed BEFORE submission (defense-in-depth ahead of the raw
 * constraint).
 *
 * The runner script reads NOTHING: no argv payload, no environment,
 * no filesystem — the constants are embedded ahead of its closed
 * evaluation body, which implements the platform kernel's closed
 * mechanical-operation semantics (a dedicated unit test pins the two
 * implementations together over a representative corpus so they
 * cannot drift silently). The file is written write-if-absent
 * (temp-file + atomic rename) under
 * `${tmpdir()}/zeck-prog-run-<sha256(content)/16>/run.mjs`: identical
 * crossing content converges on the identical path (idempotent
 * materialization, no write races), and the file persists for the
 * host process lifetime (one bounded file per distinct payload —
 * the same best-effort OS-temp-domain trust the platform's own
 * ephemeral sandbox workspaces rely on; eviction is later substrate
 * work, NOT this plane's authority).
 *
 * Wall-clock honesty (SANDBOX-BOUNDARY): the declared wall-clock bound
 * must be covered by the target environment's admitted
 * `executionTimeoutMs` — the adapter fails the run closed BEFORE
 * submission when it is not (the sandbox authority enforces the
 * timeout itself; this check makes the declared bound meaningful at
 * the authority seam).
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROGRAMMATIC_INPUT_JSON_MAX,
  PROGRAMMATIC_SPEC_JSON_MAX,
} from "../../../platform/tool-surface/programmatic";
import type {
  ProgrammaticSandboxObservation,
  ProgrammaticSandboxRequest,
  SandboxComputeSeam,
} from "../../../platform/tool-surface/seams";
import { PlatformError } from "../../../shared/errors";
import { sandboxRequestFingerprint } from "../domain/sandbox";
import type { EnvironmentCatalog, SandboxService } from "../public";

/** The run-file name inside the content-addressed directory. */
const RUN_FILE_NAME = "run.mjs";

/**
 * The generic bounded runner body (adapter infrastructure — a FIXED,
 * content-constant program implementing the platform kernel's closed
 * mechanical-operation semantics inside the sandbox process). The
 * spec and input are embedded AHEAD of this body as the constants
 * `SPEC` and `INPUT`; the runner reads nothing else — no argv, no
 * environment, no filesystem. It prints the closed result envelope to
 * stdout and exits 0 (a bound violation is a TYPED result, not a
 * process failure — the sandbox outcome stays honest).
 */
export const PROGRAMMATIC_RUNNER_BODY = [
  "const out=(o)=>process.stdout.write(JSON.stringify(o));",
  "const fail=(c,s)=>{out({ok:false,code:c,message:s});process.exit(0);};",
  "if(!SPEC||typeof SPEC!=='object'||!SPEC.bounds){fail('spec-shape','the spec envelope is malformed');}",
  "if(!INPUT||!Array.isArray(INPUT.items)){fail('input-shape','the input must carry an items array');}",
  "const b=SPEC.bounds;",
  "const items=INPUT.items;",
  "if(items.length>b.maxInputItems){fail('input-unbounded','items exceed the declared bound');}",
  "let it=0;",
  "const bump=()=>{it++;if(it>b.maxIterations){fail('iteration-exceeded','iteration bound exceeded');}};",
  "const isRec=(v)=>v!==null&&typeof v==='object'&&!Array.isArray(v);",
  "let value;",
  "if(SPEC.operation==='fan-out'){const u=[];for(let i=0;i<items.length;i++){bump();u.push({index:i,item:items[i]});}value=u;}",
  "else if(SPEC.operation==='filter'){const k=[];for(const it0 of items){bump();if(isRec(it0)&&it0[SPEC.params.field]===SPEC.params.equals){k.push(it0);}}value=k;}",
  "else if(SPEC.operation==='aggregate'){",
  " if(SPEC.params.metric==='count'){for(const it1 of items){bump();}value={count:items.length};}",
  " else{let s=0;for(const it2 of items){bump();if(!isRec(it2)){fail('output-untyped','sum aggregate requires record items');}const n=it2[SPEC.params.field];if(typeof n!=='number'||!isFinite(n)){fail('output-untyped','sum aggregate requires finite numeric fields');}s+=n;}if(!isFinite(s)){fail('output-untyped','the aggregate sum is not finite');}value={sum:s};}}",
  "else if(SPEC.operation==='projection'){const p=[];for(const it3 of items){bump();if(!isRec(it3)){fail('output-untyped','projection requires record items');}const o={};for(const f of SPEC.params.fields){o[f]=it3[f];}p.push(o);}value=p;}",
  "else{fail('operation-vocabulary','the operation is outside the closed set');}",
  "const ser=JSON.stringify(value);",
  "if(ser.length>b.maxOutputBytes){fail('output-unbounded','result exceeds the declared output bound');}",
  "out({ok:true,value:value});",
].join("\n");

/** The frozen fingerprint budget of the sandbox authority (migration 0008). */
const SANDBOX_FINGERPRINT_MAX = 500;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Materialize the content-addressed run file for ONE crossing payload
 * (the embedded spec + input constants ahead of the runner body).
 * Identical content converges on the identical path (write-if-absent
 * through temp-file + atomic rename — concurrent writers of the same
 * bytes are idempotent); the directory name pins the content digest.
 */
function materializeRunFile(specJson: string, inputJson: string): string {
  const content = `const SPEC=${specJson};\nconst INPUT=${inputJson};\n${PROGRAMMATIC_RUNNER_BODY}\n`;
  const dir = join(tmpdir(), `zeck-prog-run-${sha256Hex(content).slice(0, 32)}`);
  mkdirSync(dir, { recursive: true });
  const runPath = join(dir, RUN_FILE_NAME);
  if (!existsSync(runPath)) {
    const tempPath = join(dir, `.write-${randomUUID()}`);
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, runPath);
  }
  return runPath;
}

export interface ToolSurfaceComputeSeamOptions {
  /** The target compute environment (registered in the catalog). */
  readonly environmentId: string;
  /**
   * The neutral runner command (REQUIRED — the concrete runtime path,
   * e.g. `process.execPath`; the sandbox spawns argv without PATH, so
   * the absolute path is the honest wiring — the synthesis precedent).
   */
  readonly runnerCommand: string;
}

export interface ToolSurfaceComputeSeamDeps {
  /** The sandbox module's public service (create + dispatch). */
  readonly service: SandboxService;
  /** The sandbox module's public environment catalog (grant resolution). */
  readonly catalog: EnvironmentCatalog;
  readonly options: ToolSurfaceComputeSeamOptions;
}

/** The admission-denial error codes the service journals-then-throws. */
const DENIAL_CODES: ReadonlySet<string> = new Set<string>([
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "CAPABILITY_UNAVAILABLE",
]);

export function createToolSurfaceComputeSeam(deps: ToolSurfaceComputeSeamDeps): SandboxComputeSeam {
  const { service, catalog, options } = deps;

  return {
    async runProgrammaticWork(
      request: ProgrammaticSandboxRequest,
    ): Promise<ProgrammaticSandboxObservation> {
      // ---- 1. Bounded serialization (fail closed BEFORE anything durable).
      const specJson = JSON.stringify(request.spec);
      if (specJson.length > PROGRAMMATIC_SPEC_JSON_MAX) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: `the programmatic spec exceeds the crossing bound of ${PROGRAMMATIC_SPEC_JSON_MAX} chars`,
        });
      }
      const inputJson = JSON.stringify({ items: request.input.items });
      if (inputJson.length > PROGRAMMATIC_INPUT_JSON_MAX) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: `the programmatic input exceeds the crossing bound of ${PROGRAMMATIC_INPUT_JSON_MAX} chars`,
        });
      }

      // ---- 2. Content-addressed run-file materialization (the task's
      // single argument; the child reads nothing else).
      const runPath = materializeRunFile(specJson, inputJson);
      const task = {
        command: options.runnerCommand,
        args: [runPath],
        publicEnv: {},
      };

      // ---- 3. The frozen fingerprint budget, checked BEFORE submission
      // (the authority's own computation, from its own public contract —
      // fail closed with an actionable message ahead of the raw
      // constraint).
      const fingerprint = sandboxRequestFingerprint(
        request.scope.actor.applicationId,
        request.scope.executionId,
        request.scope.actor.actorId,
        { executionId: request.scope.executionId, environmentId: options.environmentId, task },
      );
      if (fingerprint.length > SANDBOX_FINGERPRINT_MAX) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: `the programmatic task exceeds the sandbox authority's frozen request-fingerprint budget (${fingerprint.length} > ${SANDBOX_FINGERPRINT_MAX} chars); programmatic execution fails closed`,
        });
      }

      // ---- 4. Environment grant resolution + wall-clock coverage.
      const environment = await catalog.get(
        request.scope.actor.applicationId,
        options.environmentId,
      );
      if (environment === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `the programmatic environment ${options.environmentId} is not registered in this application; programmatic execution fails closed`,
        });
      }
      const admittedTimeout = environment.spec.limits?.executionTimeoutMs ?? null;
      const declaredWallClock = request.spec.bounds.wallClockMs;
      if (admittedTimeout === null || admittedTimeout < declaredWallClock) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: `the environment's admitted timeout (${admittedTimeout ?? "none"}ms) does not cover the declared wall-clock bound (${declaredWallClock}ms); programmatic execution fails closed rather than under-bounding the work`,
        });
      }

      // ---- 5. Durable sandbox admission + dispatch (the ONLY execution).
      let created: Awaited<ReturnType<SandboxService["createSandboxExecution"]>>;
      try {
        created = await service.createSandboxExecution(
          {
            executionId: request.scope.executionId,
            environmentId: options.environmentId,
            task,
          },
          request.scope.idempotencyKey,
          request.scope.actor,
        );
      } catch (error) {
        // Journal-then-fail denials surface as typed observations (the
        // durable denial row + ledger envelope exist; the admission
        // chain decided). Everything else propagates honestly.
        if (error instanceof PlatformError && DENIAL_CODES.has(error.code)) {
          return {
            status: "denied",
            sandboxId:
              typeof (error.details as Record<string, unknown> | undefined)?.sandboxId === "string"
                ? ((error.details as Record<string, unknown>).sandboxId as string)
                : null,
            stdout: null,
            outputDigest: null,
            failure: {
              failureClass: error.code,
              message: error.message,
            },
            durationMs: null,
          };
        }
        throw error;
      }

      const finalized = await service.dispatchSandboxExecution(
        { applicationId: request.scope.actor.applicationId, sandboxId: created.id },
        request.scope.actor,
      );
      if (finalized.status === "completed") {
        const output = finalized.output;
        const stdout = typeof output?.stdout === "string" ? output.stdout : "";
        const durationMs = typeof output?.durationMs === "number" ? output.durationMs : null;
        return {
          status: "completed",
          sandboxId: finalized.id,
          stdout,
          outputDigest: finalized.outputDigest,
          failure: null,
          durationMs,
        };
      }
      if (finalized.status === "failed") {
        return {
          status: "failed",
          sandboxId: finalized.id,
          stdout: null,
          outputDigest: finalized.outputDigest,
          failure: {
            failureClass: finalized.failureClass ?? "sandbox-execution",
            message: finalized.failureMessage ?? "the sandbox execution failed",
          },
          durationMs: finalized.durationMs,
        };
      }
      // The honest crash/claim states (admitted/dispatching): the
      // sandbox authority's own fail-closed discipline — never assumed.
      return {
        status: "non-convergent",
        sandboxId: finalized.id,
        stdout: null,
        outputDigest: finalized.outputDigest,
        failure: {
          failureClass: "non-convergent",
          message: `the sandbox execution is ${finalized.status} (honest crash state); programmatic execution fails closed`,
        },
        durationMs: null,
      };
    },
  };
}
