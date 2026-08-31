/**
 * Process-environment provider adapter (sandbox module; WORK-012, ENV-002).
 *
 * Implements the neutral `SandboxProvider` port for the `process`
 * environment kind by delegating to the platform process runtime
 * (`src/platform/sandbox/process-runtime.ts`) — the only layer allowed to
 * touch host process mechanics. The observation is normalized onto the
 * sandbox axis; the module never sees process APIs directly.
 *
 * Isolation honesty (mirrored from the platform runtime): process-class
 * environments give EXPLICIT-ENV + ephemeral-workspace + no-shell + hard
 * timeout isolation. They are NOT a security boundary for arbitrary
 * untrusted code — the POLICY isolation dimension decides that (a policy
 * floor of `container` denies process environments for untrusted work;
 * containers are the initial untrusted-code path per ENV-002).
 */

import { runIsolatedProcess } from "../../../platform/sandbox/process-runtime";
import type { SandboxEnvironmentKind } from "../domain/environment";
import type {
  SandboxExecutionObservation,
  SandboxProvider,
  SandboxRuntimeSpec,
} from "../ports/sandbox-provider";

export class ProcessSandboxProvider implements SandboxProvider {
  readonly runtimeKind: SandboxEnvironmentKind = "process";

  async execute(spec: SandboxRuntimeSpec): Promise<SandboxExecutionObservation> {
    const limits = spec.limits;
    if (limits === null) {
      // A process environment without limits is unrepresentable at the
      // contract boundary (spec validation); this is the defense-in-depth
      // fail-closed check at the substrate itself.
      return {
        outcomeClass: "sandbox-failure",
        outputDigest: null,
        output: null,
        usageMicroUsd: null,
        failure: {
          failureClass: "runtime-unavailable",
          message: "process environment admitted without resource limits; refusing to execute",
          retryable: false,
        },
      };
    }
    const result = await runIsolatedProcess({
      command: spec.task.command,
      args: [...spec.task.args],
      // The EXPLICIT admitted environment ONLY — the platform runtime
      // never merges the ambient host environment (M1).
      env: { ...spec.task.publicEnv },
      timeoutMs: limits.executionTimeoutMs,
      workspace: spec.filesystem.workspace,
    });
    if (result.timedOut) {
      return {
        outcomeClass: "sandbox-failure",
        outputDigest: null,
        output: { exitCode: result.exitCode, stderr: result.stderr },
        usageMicroUsd: null,
        failure: {
          failureClass: "timeout",
          message: `process exceeded its admitted timeout of ${limits.executionTimeoutMs}ms`,
          retryable: true,
        },
      };
    }
    if (result.exitCode !== 0) {
      return {
        outcomeClass: "sandbox-failure",
        outputDigest: result.stdoutDigest,
        output: { exitCode: result.exitCode, stderr: result.stderr },
        usageMicroUsd: null,
        failure: {
          failureClass: "sandbox-execution",
          message: `process exited with code ${result.exitCode}`,
          retryable: false,
        },
      };
    }
    return {
      outcomeClass: "sandbox-success",
      outputDigest: result.stdoutDigest,
      output: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
      },
      usageMicroUsd: "0",
      failure: null,
    };
  }
}
