/**
 * Computer-use terminal executor port (tools module outbound; WORK-027,
 * CUI-002 — "terminal execution uses the approved sandbox boundary").
 *
 * The ONLY sanctioned terminal surface: every `terminal-exec` action
 * dispatches through the WORK-012 sandbox (a fully admitted, dispatched
 * and journaled sandbox execution with explicit process/filesystem/
 * network capabilities). The shipped implementation
 * (`createSandboxComputerUseTerminal`, adapters) wraps the sandbox
 * module's PUBLIC `SandboxService` — the WORK-021
 * deterministic-replacement executor pattern. There is no other
 * terminal execution path for computer use anywhere in the tools module:
 * a terminal command that never passed the sandbox admission chain is
 * unrepresentable.
 */

import type { ComputerUseTerminalPolicy } from "../domain/computer-use";

export interface ComputerUseTerminalDispatch {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly actionId: string;
  /** The shell-free argv command (the sandbox spawns argv, never a shell). */
  readonly command: string;
  readonly args: readonly string[];
  /** Explicit non-secret public env entries (the sandbox validates them). */
  readonly publicEnv: Readonly<Record<string, string>>;
  /** The terminal policy the admitted envelope declared (process/fs/net). */
  readonly terminalPolicy: ComputerUseTerminalPolicy;
  readonly timeoutMs: number;
  /** The server-derived actor scope the action rides. */
  readonly actor: {
    readonly actorId: string;
    readonly tenantId: string;
  };
}

export interface ComputerUseTerminalRun {
  readonly outcome: "succeeded" | "failed";
  /** The sandbox execution identity (durable provenance). */
  readonly sandboxExecutionId: string;
  /** Bounded stdout/stderr observation content (digests computed by the caller). */
  readonly stdout: string;
  readonly stderr: string;
  readonly failureClass: string | null;
  readonly failureMessage: string | null;
  readonly durationMs: number;
}

export interface ComputerUseTerminalExecutor {
  /**
   * Execute one terminal command through the approved sandbox boundary
   * (idempotent per the stable operation key — the sandbox's own
   * durable identity converges concurrent/duplicate dispatches).
   */
  execute(
    dispatch: ComputerUseTerminalDispatch,
    idempotencyKey: string,
  ): Promise<ComputerUseTerminalRun>;
}
