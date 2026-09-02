/**
 * Deterministic-replacement sandbox-executor adapter (tools module
 * adapter; WORK-021 — the only shipped implementation of the
 * `DeterministicReplacementExecutor` port).
 *
 * Wraps the sandbox module's PUBLIC `SandboxService` +
 * `EnvironmentCatalog`: every deterministic-replacement run — offline
 * replay validation, differential evaluation, property/metamorphic
 * test runs and mutation probes — is a fully admitted, dispatched and
 * journaled sandbox execution (durable identity, policy/capability/
 * budget admission, step-event provenance, bounded output evidence).
 * There is no other execution surface for deterministicization
 * replacement programs anywhere in the tools module (the WORK-018
 * synthesis-sandbox-executor pattern, applied to the lifecycle).
 *
 * Capability CONFINEMENT (the substrate layer — in addition to the
 * sandbox's own admission chain): before any dispatch, the declared
 * compute contract is checked against the TARGET compute
 * environment's grants and the run fails closed:
 *
 *   - `network.egress = allowlist` requires the environment's egress
 *     allowlist to COVER every declared host (a replacement program
 *     cannot reach a substrate broader than its grants);
 *   - the source is statically scanned against the v1 pure-compute
 *     subset (defense in depth — the sandbox confines the rest).
 *
 * The program source crosses as ONE task argument and the input as ONE
 * explicit public env entry (both bounded; the runner command is a
 * REQUIRED composition-root choice, e.g. `process.execPath` — the
 * sandbox spawns argv without a shell and without ambient PATH). The
 * ADAPTER's runtime shim materializes the validated input as a prelude
 * constant `INPUT` — the PROGRAM source itself stays inside the
 * pure-compute subset. Never a provider SDK.
 */

import { PlatformError } from "../../../shared/errors";
import type { ComputeEnvironmentRecord } from "../../sandbox/public";
import { SYNTHESIS_INPUT_JSON_MAX, scanLanguageSubset } from "../domain/synthesis";
import type {
  DeterministicReplacementDispatch,
  DeterministicReplacementExecutor,
  DeterministicReplacementRun,
} from "../ports/deterministic-replacement-executor";

/** The input env entry name (explicit, non-secret by contract). */
export const DETERMINISTIC_INPUT_ENV = "ZECK_DTR_INPUT";

/**
 * The runtime shim materializing the validated input as the program's
 * `INPUT` constant (adapter infrastructure — the program source stays
 * inside the pure-compute subset; only the shim touches the env).
 */
const INPUT_PRELUDE = `const INPUT = JSON.parse(process.env["${DETERMINISTIC_INPUT_ENV}"] ?? "null");\n`;

export interface DeterministicReplacementExecutorOptions {
  /** The target compute environment (must be registered in the catalog). */
  readonly environmentId: string;
  /**
   * The neutral runner command (REQUIRED — the concrete runtime path,
   * e.g. `process.execPath` for the JavaScript v1 language; the sandbox
   * spawns argv without PATH, so the absolute path is the honest wiring).
   */
  readonly runnerCommand: string;
  /** Extra runner arguments before the source (default: `["-e"]`). */
  readonly runnerArgs?: readonly string[];
}

export interface DeterministicReplacementExecutorDeps {
  /** The sandbox module's public service (create + dispatch). */
  readonly service: import("../../sandbox/public").SandboxService;
  /** The sandbox module's public environment catalog (grant resolution). */
  readonly catalog: import("../../sandbox/public").EnvironmentCatalog;
  readonly options: DeterministicReplacementExecutorOptions;
}

/**
 * The confinement verdict of a declared compute contract against an
 * environment grant (pure; exported for tests and the discrimination
 * suite).
 */
export function replacementConfinementCheck(
  contract: DeterministicReplacementDispatch["contract"],
  environment: ComputeEnvironmentRecord,
): { readonly confined: true } | { readonly confined: false; readonly reason: string } {
  if (contract.networkEgress === "allowlist") {
    if (environment.spec.network.egress !== "allowlist") {
      return {
        confined: false,
        reason: `the replacement declares allowlist network egress but environment ${environment.slug} grants none (substrate confinement: a replacement cannot exceed its grants)`,
      };
    }
    const granted = new Set(environment.spec.network.allowedHosts);
    for (const host of contract.allowedHosts) {
      if (!granted.has(host)) {
        return {
          confined: false,
          reason: `the replacement declares host "${host}" which environment ${environment.slug} does not grant (substrate confinement)`,
        };
      }
    }
  }
  return { confined: true };
}

export function createDeterministicReplacementExecutor(
  deps: DeterministicReplacementExecutorDeps,
): DeterministicReplacementExecutor {
  const { service, catalog, options } = deps;
  const runnerCommand = options.runnerCommand;
  const runnerArgs = options.runnerArgs ?? ["-e"];

  return {
    async execute(
      dispatch: DeterministicReplacementDispatch,
    ): Promise<DeterministicReplacementRun> {
      // ---- 1. Static source + input serialization (bounded, fail-closed) --
      const languageScan = scanLanguageSubset(dispatch.replacement.source);
      if (!languageScan.valid) {
        return {
          outcome: "failure",
          failureClass: "static-validation",
          message: languageScan.reason,
          sandboxExecutionId: null,
        };
      }
      let inputJson: string;
      try {
        inputJson = JSON.stringify(dispatch.input);
      } catch {
        return {
          outcome: "failure",
          failureClass: "replacement-execution",
          message: "the input is not JSON-serializable",
          sandboxExecutionId: null,
        };
      }
      if (inputJson.length > SYNTHESIS_INPUT_JSON_MAX) {
        return {
          outcome: "failure",
          failureClass: "replacement-execution",
          message: `the serialized input exceeds the v1 bound of ${SYNTHESIS_INPUT_JSON_MAX} chars (the sandbox env-entry bound)`,
          sandboxExecutionId: null,
        };
      }
      if (INPUT_PRELUDE.length + dispatch.replacement.source.length > SYNTHESIS_INPUT_JSON_MAX) {
        return {
          outcome: "failure",
          failureClass: "replacement-execution",
          message: `the shim + source exceeds the v1 task-argument bound of ${SYNTHESIS_INPUT_JSON_MAX} chars`,
          sandboxExecutionId: null,
        };
      }

      // ---- 2. Environment grant resolution + confinement (pre-dispatch) ----
      const environment = await catalog.get(dispatch.actor.applicationId, options.environmentId);
      if (environment === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `the deterministic-replacement environment ${options.environmentId} is not registered in this application; replacement execution fails closed`,
        });
      }
      const confinement = replacementConfinementCheck(dispatch.contract, environment);
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
            args: [...runnerArgs, `${INPUT_PRELUDE}${dispatch.replacement.source}`],
            publicEnv: { [DETERMINISTIC_INPUT_ENV]: inputJson },
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
          sandboxExecutionId: created.id,
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
          sandboxExecutionId: finalized.id,
        };
      }
      if (finalized.status !== "completed") {
        // The honest crash/claim states surface as a typed failure —
        // never a fabricated success.
        return {
          outcome: "failure",
          failureClass: "non-convergent",
          message: `the sandbox execution is ${finalized.status} (honest crash state); replacement execution fails closed instead of assuming an outcome`,
          sandboxExecutionId: finalized.id,
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
        sandboxExecutionId: finalized.id,
      };
    },
  };
}
