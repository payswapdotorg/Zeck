/**
 * Synthesis sandbox-executor port (tools module outbound; WORK-018,
 * acceptance criterion 2).
 *
 * THE compile/run seam of governed program synthesis: the ONLY surface
 * through which a synthesized program is executed — during runtime
 * tests AND during later tool invocations. "Compilation and execution
 * occur only inside the sandbox manager" is enforced structurally:
 *
 *   - the synthesis service (application layer) depends on this port
 *     and has NO other execution surface — no process spawning, dynamic
 *     evaluation or worker-thread usage exists anywhere under
 *     `src/modules/tools/` (the architecture test pins the tokens;
 *     the discrimination suite proves a mutated bypass is detected);
 *   - the ONLY shipped implementation of this port
 *     (`adapters/synthesis-sandbox-executor.ts`) wraps the sandbox
 *     module's public `SandboxService` — every execution is a fully
 *     admitted, dispatched and journaled sandbox execution with its
 *     own durable identity, policy/capability/budget admission and
 *     step-event provenance;
 *   - the executor is capability-CONFINING (criterion 5, substrate
 *     layer): it refuses before dispatch when the program's declared
 *     contract requirements (network hosts, secret references) exceed
 *     what the target compute environment grants — a synthesized
 *     program cannot even reach a substrate broader than its grants,
 *     independent of the (also mandatory) tool-runtime admission
 *     chain.
 *
 * The port returns observations, never authority: an outcome row for
 * evidence, stdout for output parsing, the sandbox identity for
 * provenance — nothing that mutates execution state.
 */

import type { ToolContract } from "../domain/tool";

/** What crosses INTO the sandbox (references + validated data only). */
export interface SynthesisSandboxDispatch {
  /** The program being executed (identity + source). */
  readonly program: {
    readonly toolId: string;
    readonly version: string;
    readonly sourceDigest: string;
    readonly source: string;
  };
  /** The program's declared contract (the confinement basis). */
  readonly contract: ToolContract;
  /** Input already validated against the contract's inputSchema. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Server-derived scope (never caller-asserted). */
  readonly actor: {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
  };
  /** Parent execution the run is provenance-bound to. */
  readonly executionId: string;
  /** Sandbox idempotency key (per logical run). */
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

/**
 * The normalized execution observation (the sandbox outcome mapped
 * onto the synthesis axis — never a state transition).
 */
export type SynthesisSandboxResult =
  | {
      readonly outcome: "success";
      /** The program's raw stdout (parsed by the domain's fail-closed parser). */
      readonly stdout: string;
      readonly outputDigest: string | null;
      readonly durationMs: number;
      /** The durable sandbox execution identity (provenance, criterion 4). */
      readonly sandboxId: string;
    }
  | {
      readonly outcome: "failure";
      readonly failureClass: string;
      readonly message: string;
      readonly sandboxId: string | null;
    };

export interface SynthesisSandboxExecutor {
  /**
   * Execute one program run inside the sandbox manager. Refusal
   * classes (fail-closed, BEFORE dispatch):
   *   - `CAPABILITY_UNAVAILABLE` — the program's declared
   *     network/secret requirements exceed the target environment's
   *     grants (substrate confinement);
   *   - `TOOL_ERROR` — the input serialization exceeds the v1 bound.
   */
  execute(dispatch: SynthesisSandboxDispatch): Promise<SynthesisSandboxResult>;
}
