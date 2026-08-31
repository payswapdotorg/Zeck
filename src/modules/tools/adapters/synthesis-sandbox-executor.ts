/**
 * Synthesis sandbox-executor adapter (tools module adapter; WORK-018,
 * acceptance criterion 2 — THE only shipped implementation of the
 * `SynthesisSandboxExecutor` port).
 *
 * Wraps the sandbox module's PUBLIC `SandboxService` +
 * `EnvironmentCatalog`: every synthesized-program execution — runtime
 * tests AND tool invocations — is a fully admitted, dispatched and
 * journaled sandbox execution (durable identity, policy/capability/
 * budget admission, step-event provenance, bounded output evidence).
 * There is no other execution surface for synthesized programs
 * anywhere in the tools module.
 *
 * Capability CONFINEMENT (criterion 5, the substrate layer — in
 * addition to the mandatory tool-runtime admission chain): before any
 * dispatch, the declared contract's requirements are checked against
 * the TARGET compute environment's grants and the run fails closed:
 *
 *   - `network.egress = allowlist` requires the environment's egress
 *     allowlist to COVER every declared host (a program cannot reach a
 *     substrate broader than its grants);
 *   - `secrets.access = allowlist` requires the environment's secret
 *     policy to cover every declared reference.
 *
 * The program source crosses as ONE task argument and the input as ONE
 * explicit public env entry (both bounded; raw-secret-shaped content
 * is rejected by the domain's fail-closed validation BEFORE anything
 * durable). The runner command is a composition-root choice (default:
 * `node -e`) — a neutral runtime command, never a provider SDK.
 */

import { PlatformError } from "../../../shared/errors";
import type { ComputeEnvironmentRecord } from "../../sandbox/public";
import { SYNTHESIS_INPUT_JSON_MAX } from "../domain/synthesis";
import type { ToolContract } from "../domain/tool";
import type {
  SynthesisSandboxDispatch,
  SynthesisSandboxExecutor,
  SynthesisSandboxResult,
} from "../ports/synthesis-sandbox";

/** The input env entry name (explicit, non-secret by contract). */
export const SYNTH_INPUT_ENV = "ZECK_SYNTH_INPUT";

export interface SynthesisSandboxExecutorOptions {
  /** The target compute environment (must be registered in the catalog). */
  readonly environmentId: string;
  /** The neutral runner command (default: `node`). */
  readonly runnerCommand?: string;
  /** Extra runner arguments before the source (default: `["-e"]`). */
  readonly runnerArgs?: readonly string[];
}

export interface SynthesisSandboxExecutorDeps {
  /** The sandbox module's public service (create + dispatch). */
  readonly service: import("../../sandbox/public").SandboxService;
  /** The sandbox module's public environment catalog (grant resolution). */
  readonly catalog: import("../../sandbox/public").EnvironmentCatalog;
  readonly options: SynthesisSandboxExecutorOptions;
}

/**
 * The confinement verdict of a contract against an environment grant
 * (pure; exported for tests and the discrimination suite).
 */
export function confinementCheck(
  contract: ToolContract,
  environment: ComputeEnvironmentRecord,
): { readonly confined: true } | { readonly confined: false; readonly reason: string } {
  if (contract.network.egress === "allowlist") {
    if (environment.spec.network.egress !== "allowlist") {
      return {
        confined: false,
        reason: `the program declares allowlist network egress but environment ${environment.slug} grants none (substrate confinement: a synthesized program cannot exceed its grants)`,
      };
    }
    const granted = new Set(environment.spec.network.allowedHosts);
    for (const host of contract.network.hosts) {
      if (!granted.has(host)) {
        return {
          confined: false,
          reason: `the program declares host "${host}" which environment ${environment.slug} does not grant (substrate confinement)`,
        };
      }
    }
  }
  if (contract.secrets.access === "allowlist") {
    const granted = new Set(environment.spec.secrets.secretRefs);
    for (const ref of contract.secrets.refs) {
      if (!granted.has(ref)) {
        return {
          confined: false,
          reason: `the program declares secret reference "${ref}" which environment ${environment.slug} does not mediate (substrate confinement)`,
        };
      }
    }
  }
  return { confined: true };
}

export function createSynthesisSandboxExecutor(
  deps: SynthesisSandboxExecutorDeps,
): SynthesisSandboxExecutor {
  const { service, catalog, options } = deps;
  const runnerCommand = options.runnerCommand ?? "node";
  const runnerArgs = options.runnerArgs ?? ["-e"];

  return {
    async execute(dispatch: SynthesisSandboxDispatch): Promise<SynthesisSandboxResult> {
      // ---- 1. Input serialization (bounded, fail-closed) ---------------------
      let inputJson: string;
      try {
        inputJson = JSON.stringify(dispatch.input);
      } catch {
        return {
          outcome: "failure",
          failureClass: "tool-execution",
          message: "the input is not JSON-serializable",
          sandboxId: null,
        };
      }
      if (inputJson.length > SYNTHESIS_INPUT_JSON_MAX) {
        return {
          outcome: "failure",
          failureClass: "tool-execution",
          message: `the serialized input exceeds the v1 bound of ${SYNTHESIS_INPUT_JSON_MAX} chars (the sandbox env-entry bound)`,
          sandboxId: null,
        };
      }

      // ---- 2. Environment grant resolution + confinement (pre-dispatch) ----
      const environment = await catalog.get(dispatch.actor.applicationId, options.environmentId);
      if (environment === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `the synthesis environment ${options.environmentId} is not registered in this application; synthesized-program execution fails closed`,
        });
      }
      const confinement = confinementCheck(dispatch.contract, environment);
      if (!confinement.confined) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: confinement.reason,
        });
      }

      // ---- 3. Durable sandbox admission + dispatch (the ONLY execution) ----
      const created = await service.createSandboxExecution(
        {
          executionId: dispatch.executionId,
          environmentId: options.environmentId,
          task: {
            command: runnerCommand,
            args: [...runnerArgs, dispatch.program.source],
            publicEnv: { [SYNTH_INPUT_ENV]: inputJson },
          },
        },
        dispatch.idempotencyKey,
        dispatch.actor,
      );
      if (created.status === "denied") {
        return {
          outcome: "failure",
          failureClass: "admission-denied",
          message: `the sandbox admission authority denied the run (${created.denialCode ?? created.denialClass ?? "unknown"}: ${created.denialReason ?? "no reason recorded"})`,
          sandboxId: created.id,
        };
      }
      const finalized = await service.dispatchSandboxExecution(
        { applicationId: dispatch.actor.applicationId, sandboxId: created.id },
        dispatch.actor,
      );
      if (finalized.status === "failed") {
        return {
          outcome: "failure",
          failureClass: finalized.failureClass ?? "sandbox-execution",
          message: finalized.failureMessage ?? "the sandbox execution failed",
          sandboxId: finalized.id,
        };
      }
      if (finalized.status !== "completed") {
        // The honest crash/claim states (admitted/dispatching) surface as
        // a typed failure — never a fabricated success.
        return {
          outcome: "failure",
          failureClass: "non-convergent",
          message: `the sandbox execution is ${finalized.status} (honest crash state); synthesized-program execution fails closed instead of assuming an outcome`,
          sandboxId: finalized.id,
        };
      }
      const output = finalized.output;
      const stdout = typeof output?.stdout === "string" ? output.stdout : "";
      const durationMs = typeof output?.durationMs === "number" ? output.durationMs : null;
      return {
        outcome: "success",
        stdout,
        outputDigest: finalized.outputDigest,
        durationMs: durationMs ?? 0,
        sandboxId: finalized.id,
      };
    },
  };
}
