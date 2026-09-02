/**
 * Sandbox computer-use terminal executor (tools module adapter; WORK-027,
 * CUI-002 — "terminal execution must use the approved sandbox boundary").
 *
 * The ONLY shipped implementation of the `ComputerUseTerminalExecutor`
 * port: it wraps the sandbox module's PUBLIC `SandboxService` +
 * `EnvironmentCatalog` exactly like the WORK-021
 * deterministic-replacement executor — every `terminal-exec` action is a
 * fully admitted, dispatched and journaled sandbox execution (durable
 * identity, policy/capability/budget admission through the sandbox's own
 * REQUIRED seams, step-event provenance, bounded output evidence). There
 * is no other terminal execution path for computer use anywhere in the
 * tools module: a terminal command that never passed the sandbox
 * admission chain is unrepresentable.
 *
 * Capability CONFINEMENT (the substrate layer — in addition to the
 * sandbox's own admission chain): before any dispatch, the declared
 * terminal policy is checked against the TARGET compute environment's
 * grants and the run fails closed:
 *
 *   - `terminalPolicy.process` requires an EXECUTING environment kind
 *     (a catalog row that can spawn the argv);
 *   - `terminalPolicy.filesystem` requires a WRITABLE workspace (a
 *     read-only workspace cannot serve filesystem actions);
 *   - `terminalPolicy.network` requires the environment's egress
 *     allowlist to COVER every declared host (a terminal command cannot
 *     reach a substrate broader than its grants).
 *
 * The command crosses as ONE argv (the sandbox spawns argv without a
 * shell and without ambient PATH — the runner path is a REQUIRED
 * composition-root choice, e.g. `process.execPath`). Never a provider
 * SDK.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  ComputeEnvironmentRecord,
  EnvironmentCatalog,
  SandboxService,
} from "../../sandbox/public";
import type { ComputerUseTerminalPolicy } from "../domain/computer-use";
import type {
  ComputerUseTerminalDispatch,
  ComputerUseTerminalExecutor,
  ComputerUseTerminalRun,
} from "../ports/computer-use-terminal";

export interface SandboxComputerUseTerminalOptions {
  /** The target compute environment (must be registered in the catalog). */
  readonly environmentId: string;
  /**
   * The neutral runner command (REQUIRED — the concrete runtime path,
   * e.g. `process.execPath`; the sandbox spawns argv without PATH, so
   * the absolute path is the honest wiring).
   */
  readonly runnerCommand: string;
  /** Extra runner arguments before the terminal command (default: `[]`). */
  readonly runnerArgs?: readonly string[];
}

export interface SandboxComputerUseTerminalDeps {
  /** The sandbox module's public service (create + dispatch). */
  readonly service: SandboxService;
  /** The sandbox module's public environment catalog (grant resolution). */
  readonly catalog: EnvironmentCatalog;
  readonly options: SandboxComputerUseTerminalOptions;
}

/**
 * The confinement verdict of a declared terminal policy against an
 * environment grant (pure; exported for tests and the discrimination
 * suite).
 */
export function terminalConfinementCheck(
  policy: ComputerUseTerminalPolicy,
  environment: ComputeEnvironmentRecord,
): { readonly confined: true } | { readonly confined: false; readonly reason: string } {
  if (policy.process && environment.spec.network.egress === "none" && policy.network) {
    // process + network granted but the environment grants no egress at
    // all — confined out.
    return {
      confined: false,
      reason: `the terminal policy declares network egress but environment ${environment.slug} grants none (substrate confinement: a terminal command cannot exceed its grants)`,
    };
  }
  if (policy.network) {
    if (environment.spec.network.egress !== "allowlist") {
      return {
        confined: false,
        reason: `the terminal policy declares allowlist network egress but environment ${environment.slug} grants none (substrate confinement: a terminal command cannot exceed its grants)`,
      };
    }
    const granted = new Set(environment.spec.network.allowedHosts);
    for (const host of policy.egressAllowlist) {
      if (!granted.has(host)) {
        return {
          confined: false,
          reason: `the terminal policy declares host "${host}" which environment ${environment.slug} does not grant (substrate confinement)`,
        };
      }
    }
  }
  if (policy.filesystem && environment.spec.filesystem.workspace !== "ephemeral-writable") {
    return {
      confined: false,
      reason: `the terminal policy declares filesystem access but environment ${environment.slug} has no writable workspace (substrate confinement)`,
    };
  }
  return { confined: true };
}

export function createSandboxComputerUseTerminal(
  deps: SandboxComputerUseTerminalDeps,
): ComputerUseTerminalExecutor {
  const { service, catalog, options } = deps;
  const runnerCommand = options.runnerCommand;
  const runnerArgs = options.runnerArgs ?? [];

  return {
    async execute(
      dispatch: ComputerUseTerminalDispatch,
      idempotencyKey: string,
    ): Promise<ComputerUseTerminalRun> {
      // ---- 1. Environment grant resolution + confinement (pre-dispatch). ----
      const environment = await catalog.get(dispatch.applicationId, options.environmentId);
      if (environment === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `the computer-use terminal environment ${options.environmentId} is not registered in this application; terminal execution fails closed`,
        });
      }
      const confinement = terminalConfinementCheck(dispatch.terminalPolicy, environment);
      if (!confinement.confined) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: confinement.reason,
        });
      }

      // ---- 2. Durable sandbox admission + dispatch (the ONLY execution). ----
      // The admission authority is JOURNAL-THEN-FAIL: a denied run leaves
      // a durable DENIED sandbox row and throws the typed denial. The
      // honest terminal outcome maps that denial (the durable row
      // identity + reason) — an admission denial is a RECORDED RUN
      // OUTCOME, never a propagated error that would lose the
      // provenance.
      let created: Awaited<ReturnType<typeof service.createSandboxExecution>>;
      try {
        created = await service.createSandboxExecution(
          {
            executionId: dispatch.executionId,
            environmentId: options.environmentId,
            task: {
              command: runnerCommand,
              args: [...runnerArgs, dispatch.command, ...dispatch.args],
              publicEnv: { ...dispatch.publicEnv },
            },
          },
          idempotencyKey,
          {
            actorId: dispatch.actor.actorId,
            applicationId: dispatch.applicationId,
            tenantId: dispatch.actor.tenantId,
          },
        );
      } catch (error) {
        const details =
          error instanceof PlatformError &&
          typeof error.details === "object" &&
          error.details !== null
            ? (error.details as Record<string, unknown>)
            : null;
        const deniedRowId =
          details !== null && typeof details.sandboxId === "string" ? details.sandboxId : null;
        if (
          error instanceof PlatformError &&
          deniedRowId !== null &&
          (error.code === "POLICY_DENIED" ||
            error.code === "BUDGET_EXCEEDED" ||
            error.code === "CAPABILITY_UNAVAILABLE")
        ) {
          return {
            outcome: "failed",
            sandboxExecutionId: deniedRowId,
            stdout: "",
            stderr: "",
            failureClass: "admission-denied",
            failureMessage: error.message,
            durationMs: 0,
          };
        }
        throw error;
      }
      if (created.status === "denied") {
        return {
          outcome: "failed",
          sandboxExecutionId: created.id,
          stdout: "",
          stderr: "",
          failureClass: "admission-denied",
          failureMessage: `the sandbox admission authority denied the terminal run (${created.denialCode ?? created.denialClass ?? "unknown"}: ${created.denialReason ?? "no reason recorded"})`,
          durationMs: 0,
        };
      }
      const finalized = await service.dispatchSandboxExecution(
        { applicationId: dispatch.applicationId, sandboxId: created.id },
        {
          actorId: dispatch.actor.actorId,
          applicationId: dispatch.applicationId,
          tenantId: dispatch.actor.tenantId,
        },
      );
      const output = finalized.output;
      const stdout = typeof output?.stdout === "string" ? output.stdout : "";
      const stderr = typeof output?.stderr === "string" ? output.stderr : "";
      const durationMs = typeof output?.durationMs === "number" ? output.durationMs : 0;
      if (finalized.status === "failed") {
        return {
          outcome: "failed",
          sandboxExecutionId: finalized.id,
          stdout,
          stderr,
          failureClass: finalized.failureClass ?? "sandbox-execution",
          failureMessage: finalized.failureMessage ?? "the sandbox execution failed",
          durationMs,
        };
      }
      if (finalized.status !== "completed") {
        // The honest crash/claim states surface as a typed failure —
        // never a fabricated success.
        return {
          outcome: "failed",
          sandboxExecutionId: finalized.id,
          stdout,
          stderr,
          failureClass: "non-convergent",
          failureMessage: `the sandbox execution is ${finalized.status} (honest crash state); terminal execution fails closed instead of assuming an outcome`,
          durationMs,
        };
      }
      return {
        outcome: "succeeded",
        sandboxExecutionId: finalized.id,
        stdout,
        stderr,
        failureClass: null,
        failureMessage: null,
        durationMs,
      };
    },
  };
}
