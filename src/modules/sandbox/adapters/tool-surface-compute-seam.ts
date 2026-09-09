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
 * output evidence, timeout enforcement). There is NO other execution
 * surface for programmatic work anywhere in this module, and NO
 * second sandbox: the mechanical evaluation itself runs INSIDE the
 * dispatched sandbox process through a generic, bounded RUNNER SHIM
 * (adapter infrastructure, exactly like the synthesis INPUT_PRELUDE —
 * never user source).
 *
 * The validated closed spec and the bounded input cross as TASK DATA:
 * the spec as ONE argv argument, the input serialized deterministically
 * and chunked into bounded argv pieces (the frozen task-argument
 * bound). The runner shim reads its data from argv (NEVER from the
 * ambient environment — M1 discipline) and evaluates the SAME closed
 * mechanical-operation semantics the platform kernel defines (a
 * dedicated unit test pins the two implementations together over a
 * representative corpus so they cannot drift silently).
 *
 * Wall-clock honesty (SANDBOX-BOUNDARY): the declared wall-clock bound
 * must be covered by the target environment's admitted
 * `executionTimeoutMs` — the adapter fails the run closed BEFORE
 * submission when it is not (the sandbox authority enforces the
 * timeout itself; this check makes the declared bound meaningful at
 * the authority seam).
 */

import {
  chunkPayload,
  PROGRAMMATIC_INPUT_CHUNK,
  PROGRAMMATIC_INPUT_JSON_MAX,
  PROGRAMMATIC_SPEC_JSON_MAX,
} from "../../../platform/tool-surface/programmatic";
import type {
  ProgrammaticSandboxObservation,
  ProgrammaticSandboxRequest,
  SandboxComputeSeam,
} from "../../../platform/tool-surface/seams";
import { PlatformError } from "../../../shared/errors";
import type { EnvironmentCatalog, SandboxService } from "../public";

/** The argv marker separating runner data from runtime arguments. */
export const PROGRAMMATIC_ARGV_MARKER = "--programmatic";

/**
 * The generic bounded runner shim (adapter infrastructure — a FIXED,
 * content-constant program implementing the platform kernel's closed
 * mechanical-operation semantics inside the sandbox process). Reads
 * spec + input from argv after the marker; prints the closed result
 * envelope to stdout; exits 0 (a bound violation is a TYPED result,
 * not a process failure — the sandbox outcome stays honest).
 */
export const PROGRAMMATIC_RUNNER_SHIM = [
  `const m=process.argv.indexOf(${JSON.stringify(PROGRAMMATIC_ARGV_MARKER)});`,
  "const out=(o)=>process.stdout.write(JSON.stringify(o));",
  "const fail=(c,s)=>{out({ok:false,code:c,message:s});process.exit(0);};",
  "if(m<0||process.argv.length<m+3){fail('seam-shape','missing programmatic argv marker');}",
  "let spec,input;",
  "try{spec=JSON.parse(process.argv[m+1]);input=JSON.parse(process.argv.slice(m+2).join(''));}",
  "catch(e){fail('seam-shape','unparseable programmatic payload');}",
  "if(!spec||typeof spec!=='object'||!spec.bounds){fail('spec-shape','the spec envelope is malformed');}",
  "const b=spec.bounds;",
  "if(!Array.isArray(input&&input.items)){fail('input-shape','the input must carry an items array');}",
  "const items=input.items;",
  "if(items.length>b.maxInputItems){fail('input-unbounded','items exceed the declared bound');}",
  "let it=0;",
  "const bump=()=>{it++;if(it>b.maxIterations){fail('iteration-exceeded','iteration bound exceeded');}};",
  "const isRec=(v)=>v!==null&&typeof v==='object'&&!Array.isArray(v);",
  "let value;",
  "if(spec.operation==='fan-out'){const u=[];for(let i=0;i<items.length;i++){bump();u.push({index:i,item:items[i]});}value=u;}",
  "else if(spec.operation==='filter'){const k=[];for(const it0 of items){bump();if(isRec(it0)&&it0[spec.params.field]===spec.params.equals){k.push(it0);}}value=k;}",
  "else if(spec.operation==='aggregate'){",
  " if(spec.params.metric==='count'){for(const it1 of items){bump();}value={count:items.length};}",
  " else{let s=0;for(const it2 of items){bump();if(!isRec(it2)){fail('output-untyped','sum aggregate requires record items');}const n=it2[spec.params.field];if(typeof n!=='number'||!isFinite(n)){fail('output-untyped','sum aggregate requires finite numeric fields');}s+=n;}if(!isFinite(s)){fail('output-untyped','the aggregate sum is not finite');}value={sum:s};}}",
  "else if(spec.operation==='projection'){const p=[];for(const it3 of items){bump();if(!isRec(it3)){fail('output-untyped','projection requires record items');}const o={};for(const f of spec.params.fields){o[f]=it3[f];}p.push(o);}value=p;}",
  "else{fail('operation-vocabulary','the operation is outside the closed set');}",
  "const ser=JSON.stringify(value);",
  "if(ser.length>b.maxOutputBytes){fail('output-unbounded','result exceeds the declared output bound');}",
  "out({ok:true,value:value});",
].join("\n");

export interface ToolSurfaceComputeSeamOptions {
  /** The target compute environment (registered in the catalog). */
  readonly environmentId: string;
  /**
   * The neutral runner command (REQUIRED — the concrete runtime path,
   * e.g. `process.execPath`; the sandbox spawns argv without PATH, so
   * the absolute path is the honest wiring — the synthesis precedent).
   */
  readonly runnerCommand: string;
  /** Extra runner arguments before the shim (default: `["-e"]`). */
  readonly runnerArgs?: readonly string[];
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
  const runnerArgs = options.runnerArgs ?? ["-e"];

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
      const chunks = chunkPayload(inputJson);
      if (chunks.length > 16 || chunks.some((chunk) => chunk.length > PROGRAMMATIC_INPUT_CHUNK)) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message: "the programmatic input cannot cross within the bounded argv chunks",
        });
      }

      // ---- 2. Environment grant resolution + wall-clock coverage.
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

      // ---- 3. Durable sandbox admission + dispatch (the ONLY execution).
      // The task: the generic bounded runner shim + the validated spec
      // and chunked input as argv DATA (never the ambient environment).
      let created: Awaited<ReturnType<SandboxService["createSandboxExecution"]>>;
      try {
        created = await service.createSandboxExecution(
          {
            executionId: request.scope.executionId,
            environmentId: options.environmentId,
            task: {
              command: options.runnerCommand,
              args: [
                ...runnerArgs,
                PROGRAMMATIC_RUNNER_SHIM,
                PROGRAMMATIC_ARGV_MARKER,
                specJson,
                ...chunks,
              ],
              publicEnv: {},
            },
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
