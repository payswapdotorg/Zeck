/**
 * Synthesized tool-adapter factory (tools module adapter; WORK-018).
 *
 * Implements the `SynthesizedToolAdapterFactory` port: constructs the
 * governed `ToolAdapter` for one usable program. The adapter's single
 * execution path is the `SynthesisSandboxExecutor` port (the sandbox
 * manager wrapper); dispatch-time status/expiry fail-closed checks
 * re-read the durable program row.
 */

import type { SynthesizedProgramRecord } from "../domain/synthesis";
import type { SynthesizedToolAdapterFactory } from "../ports/synthesis-adapter-factory";
import type { SynthesisSandboxExecutor } from "../ports/synthesis-sandbox";
import type { SynthesisStore } from "../ports/synthesis-store";
import type { ToolAdapter } from "../ports/tool-adapter";
import { createSynthesizedToolAdapter } from "./synthesized-tool-adapter";

export interface SynthesizedAdapterFactoryDeps {
  readonly sandbox: SynthesisSandboxExecutor;
  readonly store: SynthesisStore;
  readonly now: () => Date;
}

export function createSynthesizedAdapterFactory(
  deps: SynthesizedAdapterFactoryDeps,
): SynthesizedToolAdapterFactory {
  return {
    create(program: SynthesizedProgramRecord, timeoutMs: number): ToolAdapter {
      return createSynthesizedToolAdapter({
        sandbox: deps.sandbox,
        store: deps.store,
        program,
        timeoutMs,
        now: deps.now,
      });
    },
  };
}
