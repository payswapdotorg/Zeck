/**
 * Modal runtime provider adapter (platform substrate-economics plane;
 * WORK-054 — "Modal → adapter").
 *
 * THE MECHANISM translating the neutral compute/sandbox seam onto
 * Modal's sandbox API. Modal specifics — sandbox creation, directory
 * snapshots, warm pools, the sandbox lifecycle — live ONLY here,
 * behind the typed `ModalProviderTransport` contract (the documented
 * provider-API surface this adapter translates; in production the
 * transport is implemented by the Modal SDK client, boundary-confined
 * by the SDK table to this adapter directory; in this environment
 * live Modal APIs are NOT RUN — the adapter is exercised against
 * contract doubles with exact disclosure).
 *
 * Neutral translation table — the E1.1 research baseline documents
 * that Modal's sandbox lifecycle distinguishes created, scheduled,
 * started and ready (and in-use, which is USAGE not readiness), and
 * that application initialization can dominate raw container startup:
 * the neutral ladder was DESIGNED from these semantics, so Modal's
 * phases map 1:1:
 *
 *   Modal "created"    → neutral "created";
 *   Modal "scheduled"  → neutral "scheduled";
 *   Modal "started"    → neutral "started" (booting — started ≠
 *                          ready: the application may still be
 *                          initializing);
 *   Modal "ready"      → neutral "ready" (the readiness probe passed;
 *                          the sandbox can accept work);
 *   Modal "terminated" → typed PERMANENT rejection (an environment
 *                          that cannot accept work — never a
 *                          fabricated observation).
 *
 * Provisioning modes (composition-time configuration, never per-run
 * authority): `snapshotRef` configured → the adapter creates the
 * sandbox from the Modal directory snapshot (the snapshot
 * availability mode); otherwise cold-create. Warm pools are
 * Modal-side mechanics the readiness probe reports; the adapter never
 * assumes them ("always use warm pools" is a REJECTED alternative in
 * ADR-0020 — idle-resource cost can outweigh latency benefit).
 *
 * Cross-execution identity separation: the external environment id is
 * the digest-derived `zeck-env-…` from (runIdentity, config, timeout)
 * — two different executions never collapse into one Modal sandbox; a
 * replay re-derives the same id and the idempotent create converges.
 */

import { createHash } from "node:crypto";
import type { ContainerConfiguration } from "../../sandbox/container-profile";
import type { ContainerRunOptions, ContainerRunResult } from "../../sandbox/runtime-client";
import type { SubstrateReadinessState } from "../catalog";
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
// The Modal provider transport (vendor vocabulary CONFINED here)
// ---------------------------------------------------------------------------

/** The Modal sandbox state vocabulary (the provider's own lifecycle). */
export type ModalSandboxPhase =
  | "created"
  | "scheduled"
  | "started"
  | "ready"
  | "in-use"
  | "terminated";

/** One Modal sandbox creation request. */
export interface ModalCreateRequest {
  /** The derived external environment identity (idempotent submission key). */
  readonly environmentId: string;
  /** The Modal image/app reference the adapter's binding maps the image to. */
  readonly imageRef: string;
  /** Restore from this Modal directory snapshot instead of cold-creating. */
  readonly snapshotRef?: string;
}

/** One Modal command execution request. */
export interface ModalCommandRequest {
  /** The provider sandbox handle the command executes in. */
  readonly sandboxId: string;
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * The documented Modal API surface the adapter translates (NOT RUN
 * live in this environment — contract doubles in tests).
 * `probeReadiness` reports the adapter's bound environment space
 * (the warm pool's state as the provider sees it) — one adapter
 * instance binds exactly one substrate.
 */
export interface ModalProviderTransport {
  /** Create (or idempotently return) a sandbox for the environment id. */
  createSandbox(request: ModalCreateRequest): Promise<{ readonly sandboxId: string }>;
  /** Observe one sandbox's current phase. */
  getSandboxPhase(sandboxId: string): Promise<{ readonly phase: ModalSandboxPhase }>;
  /** Probe the adapter's bound environment space (the readiness seam). */
  probeReadiness(): Promise<{ readonly phase: ModalSandboxPhase }>;
  /** Run one command inside the sandbox (bounded by the timeout). */
  runCommand(request: ModalCommandRequest): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut: boolean;
    readonly durationMs: number;
  }>;
  /** Terminate one sandbox (best effort; bounded by the caller). */
  terminateSandbox(sandboxId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The adapter configuration
// ---------------------------------------------------------------------------

export interface ModalAdapterConfig {
  /** The opaque neutral adapter reference (the composition binding key). */
  readonly adapterRef: string;
  /** The Modal image reference the neutral `image` maps to (composition binding). */
  readonly imageRef: string;
  /** Optional directory-snapshot reference — restores instead of cold creates. */
  readonly snapshotRef?: string;
  /** The now seam (observations carry the probe instant; tests inject). */
  readonly nowEpochMs?: () => number;
  /** The bounded wait for sandbox readiness (ms; default 120000). */
  readonly readinessTimeoutMs?: number;
}

const READINESS_TIMEOUT_BOUNDS = { min: 1000, max: 600_000 } as const;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;

/**
 * Map the Modal phase onto the neutral readiness ladder (fail closed).
 * "in-use" is USAGE, not readiness — an in-use sandbox may still
 * accept queued work on the provider's side, but honesty demands the
 * probe report what the provider asserts: an in-use environment is
 * NOT reported "ready" (the warm collapse requires an idle READY
 * environment).
 */
function mapModalPhase(phase: ModalSandboxPhase, adapterRef: string): SubstrateReadinessState {
  if (phase === "created" || phase === "scheduled" || phase === "started") {
    return phase;
  }
  if (phase === "ready") {
    return "ready";
  }
  if (phase === "in-use") {
    // A busy environment is not an idle-ready one: report "started"
    // (provisioned, not free to accept work now) — the conservative
    // fail-closed reading; the selection never gets a free warm
    // collapse from a busy pool.
    return "started";
  }
  // terminated: cannot accept work — typed PERMANENT rejection.
  throw new SubstrateAdapterError(
    adapterRef,
    `the Modal sandbox is in phase "${phase}" and cannot accept work (fail closed)`,
    "permanent",
  );
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Build the Modal substrate adapter over its provider transport. */
export function createModalAdapter(
  config: ModalAdapterConfig,
  transport: ModalProviderTransport,
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
        imageRef: config.imageRef,
        ...(config.snapshotRef === undefined ? {} : { snapshotRef: config.snapshotRef }),
      });
      return sandboxId;
    } catch (error) {
      throw new SubstrateAdapterError(
        adapterRef,
        `Modal sandbox create/restore failed: ${error instanceof Error ? error.message : String(error)}`,
        "transient",
      );
    }
  };

  return {
    adapterRef,
    servesIsolation: ["container"],
    runtimeId: `substrate-runtime:${adapterRef}`,

    async run(
      configuration: ContainerConfiguration,
      options: ContainerRunOptions,
    ): Promise<ContainerRunResult> {
      const sandboxId = await resolveSandbox(configuration, options);
      // Bounded readiness wait: the FULL created→scheduled→started→ready
      // path (application initialization can dominate raw boot — the
      // research-baseline lesson; never assume ready).
      const deadline = now() + readinessTimeoutMs;
      for (;;) {
        let observed: ModalSandboxPhase;
        try {
          observed = (await transport.getSandboxPhase(sandboxId)).phase;
        } catch (error) {
          throw new SubstrateAdapterError(
            adapterRef,
            `Modal phase observation failed: ${error instanceof Error ? error.message : String(error)}`,
            "transient",
          );
        }
        const state = mapModalPhase(observed, adapterRef);
        if (state === "ready") {
          break;
        }
        if (now() >= deadline) {
          throw new SubstrateAdapterError(
            adapterRef,
            `Modal sandbox did not become ready within ${readinessTimeoutMs}ms (fail closed)`,
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
          `Modal command execution failed: ${error instanceof Error ? error.message : String(error)}`,
          "transient",
        );
      }
    },

    async observeReadiness(request: ReadinessProbeRequest): Promise<ReadinessObservation> {
      let phase: ModalSandboxPhase;
      try {
        phase = (await transport.probeReadiness()).phase;
      } catch (error) {
        throw new SubstrateAdapterError(
          adapterRef,
          `Modal readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
          "transient",
        );
      }
      const state = mapModalPhase(phase, adapterRef);
      return validateReadinessObservation({
        substrateId: request.substrateId,
        state,
        observedAtEpochMs: now(),
        source: `substrate-probe:${adapterRef}`,
      });
    },
  };
}
