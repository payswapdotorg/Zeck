/**
 * E2B runtime provider adapter (platform substrate-economics plane;
 * WORK-054 — "E2B → adapter").
 *
 * THE MECHANISM translating the neutral compute/sandbox seam
 * (`ContainerRuntimeClient`: execute exactly a validated
 * `ContainerConfiguration` under the execution-scoped `runIdentity`)
 * onto E2B's sandbox API. E2B specifics — sandbox templates, snapshot
 * restores, command execution inside a sandbox — live ONLY here,
 * behind the typed `E2bProviderTransport` contract (the documented
 * provider-API surface this adapter translates; in production the
 * transport is implemented by the E2B SDK client, boundary-confined
 * by the SDK table to this adapter directory; in this environment
 * live E2B APIs are NOT RUN — the adapter is exercised against
 * contract doubles with exact disclosure).
 *
 * Neutral translation table (the provider phases map onto the frozen
 * readiness ladder; the mapping is THIS adapter's mechanism, recorded
 * in its observations):
 *
 *   E2B "creating" → neutral "started" (the sandbox is booting — NOT
 *                    yet usable; started ≠ ready);
 *   E2B "running"  → neutral "ready" (the sandbox accepts commands);
 *   E2B "stopped"/"not-found" → typed PERMANENT rejection (an
 *                    environment that cannot accept work — never a
 *                    fabricated observation).
 *
 * Provisioning modes (composition-time configuration, never per-run
 * authority): `snapshotId` configured → the adapter restores from the
 * E2B snapshot (the snapshot availability mode); otherwise it creates
 * from the template (cold). Warm pools are E2B-side mechanics the
 * readiness probe reports; the adapter never assumes them.
 *
 * Cross-execution identity separation: the external environment
 * identity is the digest-derived `zeck-env-…` from (runIdentity,
 * config, timeout) — two different executions never collapse into one
 * E2B sandbox; a replay of the same logical run re-derives the same id
 * and the idempotent create converges (the transport contract
 * guarantees create-with-existing-id returns the existing sandbox).
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
// The E2B provider transport (vendor vocabulary CONFINED here)
// ---------------------------------------------------------------------------

/** The E2B sandbox state vocabulary (the provider's own phases). */
export type E2bSandboxPhase = "creating" | "running" | "stopped" | "not-found";

/** One E2B sandbox creation/restore request. */
export interface E2bCreateRequest {
  /** The derived external environment identity (idempotent submission key). */
  readonly environmentId: string;
  /** The E2B sandbox template the adapter's binding maps the image to. */
  readonly templateId: string;
  /** Restore from this E2B snapshot instead of cold-creating. */
  readonly snapshotId?: string;
}

/** One E2B command execution request. */
export interface E2bCommandRequest {
  /** The provider sandbox handle the command executes in. */
  readonly sandboxId: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * The documented E2B API surface the adapter translates. Transport
 * implementations are the provider SDK boundary (NOT RUN live in this
 * environment — contract doubles in tests). `probeReadiness` reports
 * the phase of the ADAPTER'S BOUND environment space (the template's
 * warm-pool/snapshot availability as the provider sees it) — one
 * adapter instance binds exactly one substrate (adapterRef 1:1).
 */
export interface E2bProviderTransport {
  /** Create (or idempotently return) a sandbox for the environment id. */
  createSandbox(request: E2bCreateRequest): Promise<{ readonly sandboxId: string }>;
  /** Observe one sandbox's current phase. */
  getSandboxPhase(sandboxId: string): Promise<{ readonly phase: E2bSandboxPhase }>;
  /** Probe the adapter's bound environment space (the readiness seam). */
  probeReadiness(): Promise<{ readonly phase: E2bSandboxPhase }>;
  /** Run one command inside the sandbox (bounded by the timeout). */
  runCommand(request: E2bCommandRequest): Promise<{
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

export interface E2bAdapterConfig {
  /** The opaque neutral adapter reference (the composition binding key). */
  readonly adapterRef: string;
  /** The E2B template id the neutral `image` maps to (composition binding). */
  readonly templateId: string;
  /** Optional snapshot id — configured restores instead of cold creates. */
  readonly snapshotId?: string;
  /** The now seam (observations carry the probe instant; tests inject). */
  readonly nowEpochMs?: () => number;
  /** The bounded wait for sandbox readiness (ms; default 120000). */
  readonly readinessTimeoutMs?: number;
}

const READINESS_TIMEOUT_BOUNDS = { min: 1000, max: 600_000 } as const;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;

/** Map the E2B phase onto the neutral readiness ladder (fail closed). */
function mapE2bPhase(phase: E2bSandboxPhase, adapterRef: string): "started" | "ready" {
  if (phase === "running") {
    return "ready";
  }
  if (phase === "creating") {
    return "started";
  }
  // stopped / not-found: an environment that cannot accept work — a
  // typed PERMANENT rejection, never a fabricated observation.
  throw new SubstrateAdapterError(
    adapterRef,
    `the E2B sandbox is in phase "${phase}" and cannot accept work (fail closed)`,
    "permanent",
  );
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Build the E2B substrate adapter over its provider transport. */
export function createE2bAdapter(
  config: E2bAdapterConfig,
  transport: E2bProviderTransport,
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

  /** Resolve the sandbox for a run (idempotent create/restore). */
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
        templateId: config.templateId,
        ...(config.snapshotId === undefined ? {} : { snapshotId: config.snapshotId }),
      });
      return sandboxId;
    } catch (error) {
      throw new SubstrateAdapterError(
        adapterRef,
        `E2B sandbox create/restore failed: ${error instanceof Error ? error.message : String(error)}`,
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
      // Bounded readiness wait: poll the provider phase until the sandbox
      // can accept work (the full created→ready path — never assumed).
      const deadline = now() + readinessTimeoutMs;
      for (;;) {
        let observed: E2bSandboxPhase;
        try {
          observed = (await transport.getSandboxPhase(sandboxId)).phase;
        } catch (error) {
          throw new SubstrateAdapterError(
            adapterRef,
            `E2B phase observation failed: ${error instanceof Error ? error.message : String(error)}`,
            "transient",
          );
        }
        mapE2bPhase(observed, adapterRef);
        if (observed === "running") {
          break;
        }
        if (now() >= deadline) {
          throw new SubstrateAdapterError(
            adapterRef,
            `E2B sandbox did not become ready within ${readinessTimeoutMs}ms (fail closed)`,
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
          `E2B command execution failed: ${error instanceof Error ? error.message : String(error)}`,
          "transient",
        );
      }
    },

    async observeReadiness(request: ReadinessProbeRequest): Promise<ReadinessObservation> {
      let phase: E2bSandboxPhase;
      try {
        phase = (await transport.probeReadiness()).phase;
      } catch (error) {
        throw new SubstrateAdapterError(
          adapterRef,
          `E2B readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
          "transient",
        );
      }
      const state = mapE2bPhase(phase, adapterRef);
      return validateReadinessObservation({
        substrateId: request.substrateId,
        state,
        observedAtEpochMs: now(),
        source: `substrate-probe:${adapterRef}`,
      });
    },
  };
}
