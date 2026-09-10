/**
 * Daytona runtime provider adapter (platform substrate-economics
 * plane; WORK-054 — "Daytona → adapter").
 *
 * THE MECHANISM translating the neutral compute/sandbox seam onto
 * Daytona's sandbox API. Daytona specifics — sandboxes, snapshot
 * restores, warm pools — live ONLY here, behind the typed
 * `DaytonaProviderTransport` contract (the documented provider-API
 * surface this adapter translates; in production the transport is
 * implemented by the Daytona SDK client, boundary-confined by the SDK
 * table to this adapter directory; in this environment live Daytona
 * APIs are NOT RUN — the adapter is exercised against contract
 * doubles with exact disclosure).
 *
 * Neutral translation table (Daytona's documented states onto the
 * frozen readiness ladder — E1.1 research baseline: Daytona's warm
 * pools keep matching sandboxes pre-created and READY; the pools are
 * Daytona-side mechanics this adapter REPORTS, never assumes):
 *
 *   Daytona "pending"  → neutral "started" (provisioning/booting —
 *                        started ≠ ready);
 *   Daytona "running"  → neutral "ready" (the sandbox accepts work);
 *   Daytona "stopped"/"archived"/"not-found" → typed PERMANENT
 *                        rejection (an environment that cannot accept
 *                        work — never a fabricated observation).
 *
 * Provisioning modes (composition-time configuration, never per-run
 * authority): `snapshotId` configured → the adapter creates the
 * sandbox FROM the Daytona snapshot (the snapshot availability mode);
 * otherwise cold-create. Warm-pool attach is the provider's routing
 * decision inside create (the transport contract); the readiness
 * probe reports the resulting state.
 *
 * Cross-execution identity separation: the external environment id is
 * the digest-derived `zeck-env-…` from (runIdentity, config, timeout)
 * — two different executions never collapse into one Daytona sandbox;
 * a replay re-derives the same id and the idempotent create converges.
 */

import { createHash } from "node:crypto";
import type { ContainerConfiguration } from "../../sandbox/container-profile";
import type { ContainerRunOptions, ContainerRunResult } from "../../sandbox/runtime-client";
import { type ReadinessObservation, validateReadinessObservation } from "../lifecycle";
import {
  boundProviderOutput,
  deriveEnvironmentIdentity,
  type ReadinessProbeRequest,
  SubstrateAdapterError,
  type SubstrateRuntimeAdapter,
  validateAdapterRef,
  validateAdapterRunOptions,
} from "./port";

// ---------------------------------------------------------------------------
// The Daytona provider transport (vendor vocabulary CONFINED here)
// ---------------------------------------------------------------------------

/** The Daytona sandbox state vocabulary (the provider's own phases). */
export type DaytonaSandboxPhase = "pending" | "running" | "stopped" | "archived" | "not-found";

/** One Daytona sandbox creation request. */
export interface DaytonaCreateRequest {
  /** The derived external environment identity (idempotent submission key). */
  readonly environmentId: string;
  /** Restore from this Daytona snapshot instead of cold-creating. */
  readonly snapshotId?: string;
}

/** One Daytona command execution request. */
export interface DaytonaCommandRequest {
  /** The provider sandbox handle the command executes in. */
  readonly sandboxId: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * The documented Daytona API surface the adapter translates (NOT RUN
 * live in this environment — contract doubles in tests). Warm-pool
 * attach happens provider-side inside `createSandbox` (Daytona routes
 * matching pre-created sandboxes); `probeReadiness` reports the
 * adapter's bound environment space (the pool's state as the provider
 * sees it) — one adapter instance binds exactly one substrate.
 */
export interface DaytonaProviderTransport {
  /** Create (or idempotently return) a sandbox for the environment id. */
  createSandbox(request: DaytonaCreateRequest): Promise<{ readonly sandboxId: string }>;
  /** Observe one sandbox's current phase. */
  getSandboxPhase(sandboxId: string): Promise<{ readonly phase: DaytonaSandboxPhase }>;
  /** Probe the adapter's bound environment space (the readiness seam). */
  probeReadiness(): Promise<{ readonly phase: DaytonaSandboxPhase }>;
  /** Run one command inside the sandbox (bounded by the timeout). */
  runCommand(request: DaytonaCommandRequest): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly durationMs: number;
  }>;
  /** Tear one sandbox down (best effort; bounded by the caller). */
  destroySandbox(sandboxId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The adapter configuration
// ---------------------------------------------------------------------------

export interface DaytonaAdapterConfig {
  /** The opaque neutral adapter reference (the composition binding key). */
  readonly adapterRef: string;
  /** Optional snapshot id — configured restores instead of cold creates. */
  readonly snapshotId?: string;
  /** The now seam (observations carry the probe instant; tests inject). */
  readonly nowEpochMs?: () => number;
  /** The bounded wait for sandbox readiness (ms; default 120000). */
  readonly readinessTimeoutMs?: number;
}

const READINESS_TIMEOUT_BOUNDS = { min: 1000, max: 600_000 } as const;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;

/** Map the Daytona phase onto the neutral readiness ladder (fail closed). */
function mapDaytonaPhase(phase: DaytonaSandboxPhase, adapterRef: string): "started" | "ready" {
  if (phase === "running") {
    return "ready";
  }
  if (phase === "pending") {
    return "started";
  }
  // stopped / archived / not-found: cannot accept work — typed
  // PERMANENT rejection, never a fabricated observation.
  throw new SubstrateAdapterError(
    adapterRef,
    `the Daytona sandbox is in phase "${phase}" and cannot accept work (fail closed)`,
    "permanent",
  );
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Build the Daytona substrate adapter over its provider transport. */
export function createDaytonaAdapter(
  config: DaytonaAdapterConfig,
  transport: DaytonaProviderTransport,
): SubstrateRuntimeAdapter {
  const adapterRef = validateAdapterRef(config.adapterRef);
  const now = config.nowEpochMs ?? (() => Date.now());
  const readinessTimeoutMs = config.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (
    !Number.isInteger(readinessTimeoutMs) ||
    readinessTimeoutMs < READINESS_TIMEOUT_BOUNDS.min ||
    readinessTimeoutMs > READINESS_TIMEOUT_BOUNDS.max
  ) {
    throw new SubstrateAdapterError(
      adapterRef,
      `readinessTimeoutMs must be bounded [${READINESS_TIMEOUT_BOUNDS.min}, ${READINESS_TIMEOUT_BOUNDS.max}]`,
      "permanent",
    );
  }

  const resolveSandbox = async (
    configuration: ContainerConfiguration,
    options: ContainerRunOptions,
  ): Promise<string> => {
    validateAdapterRunOptions(options, adapterRef);
    const environmentId = deriveEnvironmentIdentity(
      options.runIdentity,
      configuration,
      options.timeoutMs,
    );
    try {
      const { sandboxId } = await transport.createSandbox({
        environmentId,
        ...(config.snapshotId === undefined ? {} : { snapshotId: config.snapshotId }),
      });
      return sandboxId;
    } catch (error) {
      throw new SubstrateAdapterError(
        adapterRef,
        `Daytona sandbox create/restore failed: ${error instanceof Error ? error.message : String(error)}`,
        "transient",
      );
    }
  };

  return {
    adapterRef,
    servesIsolation: ["microvm"],
    runtimeId: `substrate-runtime:${adapterRef}`,

    async run(
      configuration: ContainerConfiguration,
      options: ContainerRunOptions,
    ): Promise<ContainerRunResult> {
      const sandboxId = await resolveSandbox(configuration, options);
      // Bounded readiness wait (the full provisioning→ready path).
      const deadline = now() + readinessTimeoutMs;
      for (;;) {
        let observed: DaytonaSandboxPhase;
        try {
          observed = (await transport.getSandboxPhase(sandboxId)).phase;
        } catch (error) {
          throw new SubstrateAdapterError(
            adapterRef,
            `Daytona phase observation failed: ${error instanceof Error ? error.message : String(error)}`,
            "transient",
          );
        }
        mapDaytonaPhase(observed, adapterRef);
        if (observed === "running") {
          break;
        }
        if (now() >= deadline) {
          throw new SubstrateAdapterError(
            adapterRef,
            `Daytona sandbox did not become ready within ${readinessTimeoutMs}ms (fail closed)`,
            "transient",
          );
        }
      }
      try {
        const result = await transport.runCommand({
          sandboxId,
          program: configuration.command,
          args: [...configuration.args],
          env: Object.fromEntries(configuration.env.map((entry) => [entry.name, entry.value])),
          timeoutMs: options.timeoutMs,
        });
        const stdout = boundProviderOutput(result.stdout);
        return {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdout,
          stderr: boundProviderOutput(result.stderr),
          stdoutDigest: createHash("sha256").update(stdout, "utf8").digest("hex"),
          durationMs: result.durationMs,
        };
      } catch (error) {
        throw new SubstrateAdapterError(
          adapterRef,
          `Daytona command execution failed: ${error instanceof Error ? error.message : String(error)}`,
          "transient",
        );
      }
    },

    async observeReadiness(request: ReadinessProbeRequest): Promise<ReadinessObservation> {
      let phase: DaytonaSandboxPhase;
      try {
        phase = (await transport.probeReadiness()).phase;
      } catch (error) {
        throw new SubstrateAdapterError(
          adapterRef,
          `Daytona readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
          "transient",
        );
      }
      const state = mapDaytonaPhase(phase, adapterRef);
      return validateReadinessObservation({
        substrateId: request.substrateId,
        state,
        observedAtEpochMs: now(),
        source: `substrate-probe:${adapterRef}`,
      });
    },
  };
}
