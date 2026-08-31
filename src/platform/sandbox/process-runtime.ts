/**
 * Process-environment runtime (platform sandbox seam; WORK-012).
 *
 * The PROCESS substrate executor: runs ONE argv command in an isolated
 * ephemeral workspace with an EXPLICIT environment — the honest, bounded
 * controls the process class of environment can actually establish on a
 * host OS WITHOUT a container runtime:
 *
 *   - ENVIRONMENT ISOLATION: the child environment is built from the
 *     admitted `env` entries ONLY (`env: { ...explicit }` — the ambient
 *     host environment is NEVER inherited; there is no `process.env`
 *     spread anywhere in this file — discrimination M1);
 *   - FILESYSTEM ISOLATION: the working directory is a fresh ephemeral
 *     directory (mkdtemp) — the ONLY directory made visible to the task;
 *     read-only workspaces are chmod 0o555 (best-effort);
 *   - NO SHELL: argv discipline (`spawn(command, args, { shell: false })`);
 *   - TIME BOUND: the admitted `executionTimeoutMs` is enforced here by
 *     the runtime itself (SIGKILL on expiry) — the service additionally
 *     enforces it defensively around the provider call;
 *   - CLEANUP: the ephemeral workspace is removed after the run.
 *
 * HONEST ISOLATION GUARANTEES (documented, not claimed beyond evidence):
 * process-level controls are NOT a security boundary against arbitrary
 * untrusted code — a process can still reach the host network, read host
 * files it can access by permission, and spawn children (the processCount
 * bound is DECLARED and forwarded but not OS-enforced here). That is
 * exactly why the architecture makes CONTAINERS the initial untrusted-code
 * path (`spec/requirements.md` ENV-002, `spec/architecture.md` §2.10):
 * the POLICY isolation dimension decides which kinds may run where — a
 * policy floor of `container` denies process environments for untrusted
 * work. This runtime is the substrate for policy-admitted process-class
 * work only (deterministic programs, trusted tooling).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProcessRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  /** The EXPLICIT environment entries — the ambient environment is never merged. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly workspace: "none" | "ephemeral-read-only" | "ephemeral-writable";
  /** Max output bytes retained per stream (bounded evidence, default 1 MiB). */
  readonly maxOutputBytes?: number;
}

export interface ProcessRunResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutDigest: string;
  readonly durationMs: number;
}

const MAX_OUTPUT_BYTES_DEFAULT = 1024 * 1024;

/**
 * Run one isolated process. The ambient host environment is structurally
 * excluded: the child receives EXACTLY `options.env`.
 */
export function runIsolatedProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES_DEFAULT;
  const started = Date.now();
  // The ephemeral isolated workspace: the only directory this run touches.
  const workspaceDir = mkdtempSync(join(tmpdir(), "zeck-sandbox-"));
  if (options.workspace === "ephemeral-read-only") {
    chmodSync(workspaceDir, 0o555);
  }

  return new Promise<ProcessRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // The child environment: EXPLICIT entries only — never the ambient one.
    const childEnv: Record<string, string> = { ...options.env };

    const child = spawn(options.command, [...options.args], {
      cwd: workspaceDir,
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= maxBytes) {
        return current;
      }
      return (current + chunk.toString("utf8")).slice(0, maxBytes);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      // Cleanup: the ephemeral workspace never outlives the run.
      try {
        rmSync(workspaceDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // best-effort cleanup; the OS temp sweeper is the backstop
      }
      resolve({
        exitCode,
        timedOut,
        stdout,
        stderr,
        stdoutDigest: createHash("sha256").update(stdout, "utf8").digest("hex"),
        durationMs,
      });
    };

    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}
