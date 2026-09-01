/**
 * Synthesized tool adapter (tools module adapter; WORK-018).
 *
 * The `ToolAdapter` bound when a `usable` synthesized program is
 * registered as a governed tool: its dispatch executes the program
 * through the SAME `SynthesisSandboxExecutor` port used during
 * runtime tests — there is exactly ONE execution path for synthesized
 * code (the sandbox manager), before and after binding.
 *
 * Defense-in-depth at dispatch time (fail-closed):
 *   - EXPIRY: an ephemeral program past `expiresAt` never executes;
 *   - STATUS: the adapter re-reads the program row and requires
 *     `usable` — a retired program fails closed even if a stale
 *     adapter handle survives in the registry;
 *   - the input is validated against the contract's inputSchema by
 *     the RUNTIME before the adapter is invoked; the adapter parses
 *     the program's stdout with the domain's fail-closed parser and
 *     the runtime validates the parsed output against the contract's
 *     outputSchema (an output-contract violation is a typed tool
 *     failure, never a success).
 *
 * The adapter receives only the dispatch + execution context — no
 * stores beyond the program store, no authorities, no mutation
 * surfaces (the port's authority shape, preserved).
 */

import type { SynthesizedProgramRecord } from "../domain/synthesis";
import { parseSynthesizedOutput } from "../domain/synthesis";
import type {
  SynthesisSandboxDispatch,
  SynthesisSandboxExecutor,
} from "../ports/synthesis-sandbox";
import type { SynthesisStore } from "../ports/synthesis-store";
import type {
  ToolAdapter,
  ToolDispatch,
  ToolDispatchContext,
  ToolObservation,
} from "../ports/tool-adapter";

export interface SynthesizedToolAdapterDeps {
  readonly sandbox: SynthesisSandboxExecutor;
  /** Re-read for the dispatch-time status/expiry fail-closed checks. */
  readonly store: SynthesisStore;
  readonly program: SynthesizedProgramRecord;
  readonly timeoutMs: number;
  readonly now: () => Date;
}

/** The sandbox idempotency key for one tool invocation's execution. */
function invocationKey(programId: string, invocationId: string): string {
  return `synth-invoke:${programId}:${invocationId}`;
}

export function createSynthesizedToolAdapter(deps: SynthesizedToolAdapterDeps): ToolAdapter {
  const { sandbox, store, program, timeoutMs, now } = deps;

  return {
    async execute(dispatch: ToolDispatch, context: ToolDispatchContext): Promise<ToolObservation> {
      // ---- 1. Dispatch-time fail-closed checks (defense in depth) --------
      const current = await store.get(program.applicationId, program.id);
      if (current === null || current.status !== "usable") {
        return {
          kind: "tool-failure",
          failure: {
            failureClass: "tool-execution",
            message: `the synthesized program ${program.toolId} is no longer usable (status: ${current?.status ?? "unknown"}); the adapter fails closed`,
            retryable: false,
          },
        };
      }
      if (now().toISOString() >= current.expiresAt) {
        return {
          kind: "tool-failure",
          failure: {
            failureClass: "tool-execution",
            message: `the synthesized program ${program.toolId} expired at ${current.expiresAt}; ephemeral programs are never executed past expiry`,
            retryable: false,
          },
        };
      }

      // ---- 2. The single execution path: the sandbox manager -------------
      const execDispatch: SynthesisSandboxDispatch = {
        program: {
          toolId: program.toolId,
          version: program.version,
          sourceDigest: program.sourceDigest,
          source: program.source,
        },
        contract: dispatch.contract,
        input: dispatch.input,
        actor: {
          // The invocation owns its sandbox execution (durable identity,
          // provenance-bound; the runtime's dispatch carries no caller
          // actor identity by design — the invocation IS the actor).
          actorId: dispatch.invocationId,
          applicationId: context.applicationId,
          tenantId: context.tenantId,
        },
        executionId: context.executionId,
        idempotencyKey: invocationKey(program.id, dispatch.invocationId),
        timeoutMs,
      };
      const result = await sandbox.execute(execDispatch);
      if (result.outcome === "failure") {
        const failureClass =
          result.failureClass === "timeout"
            ? "timeout"
            : result.failureClass === "admission-denied"
              ? "adapter-error"
              : "tool-execution";
        return {
          kind: "tool-failure",
          failure: {
            failureClass,
            message: result.message,
            retryable: failureClass === "timeout",
          },
        };
      }

      // ---- 3. Fail-closed output parsing ----------------------------------
      const parsed = parseSynthesizedOutput(result.stdout);
      if (!parsed.ok) {
        return {
          kind: "tool-failure",
          failure: {
            failureClass: "output-contract",
            message: parsed.reason,
            retryable: false,
          },
        };
      }
      return { kind: "tool-success", output: parsed.output, usageMicroUsd: "0" };
    },
  };
}

export { invocationKey };
