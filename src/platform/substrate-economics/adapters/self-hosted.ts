/**
 * Self-hosted runtime provider adapter (platform substrate-economics
 * plane; WORK-054 — "self-host → adapter, where the repository
 * already supports it").
 *
 * THE MECHANISM for customer/self-hosted substrates: the repository
 * ALREADY supports self-hosted execution through the documented
 * container-runner REST protocol (`src/platform/compute/container-
 * runtime.ts`, D-05: "a dedicated execution-plane host process —
 * first-party fleet runner OR A GOVERNED CUSTOMER RUNNER") — the
 * neutral `ContainerRuntimeClient` seam. This adapter wraps an
 * EXISTING client (any implementation of the declared seam) and adds
 * the substrate-facts reporting the substrate-economics plane decides
 * on: it is the zero-new-protocol adapter — every execution rides the
 * existing seam unchanged.
 *
 * Readiness reporting (the honest boundary): a self-hosted runner may
 * expose a health probe; when the composition root configures one,
 * `observeReadiness` maps its result onto the neutral ladder
 * ("ready"/"starting"/"down" → ready/started/typed-permanent). When
 * NO probe is configured the observation is a TYPED PERMANENT
 * failure — the adapter cannot report what it cannot measure; it
 * NEVER fabricates a ready observation and NEVER treats the absence
 * of a probe as readiness (invariant 6: adapters report; the
 * execution layer decides; a missing report is a missing report).
 *
 * The isolation classes this adapter serves are CONSTRUCTOR-DECLARED
 * (a governed customer runner's isolation class is a deployment
 * fact: container, microvm, customer-runner, …) — the binding
 * validation refuses a descriptor whose declared isolation the
 * adapter does not serve.
 *
 * Cross-execution identity separation rides the WRAPPED client's own
 * run-identity discipline (the D-05 contract) — this adapter adds
 * nothing and weakens nothing.
 */

import type { IsolationLevel } from "../../execution-ir/constraints";
import type {
  ContainerRunOptions,
  ContainerRunResult,
  ContainerRuntimeClient,
} from "../../sandbox/runtime-client";
import { type ReadinessObservation, validateReadinessObservation } from "../lifecycle";
import {
  type ReadinessProbeRequest,
  SubstrateAdapterError,
  type SubstrateRuntimeAdapter,
  validateAdapterRef,
} from "./port";

// ---------------------------------------------------------------------------
// The self-hosted probe transport (the deployment's health seam)
// ---------------------------------------------------------------------------

/** The self-hosted runner health-probe result vocabulary. */
export type SelfHostedProbePhase = "ready" | "starting" | "down";

/**
 * The self-hosted health probe the deployment may expose (the
 * customer runner's own readiness endpoint). Absent probe = no
 * readiness reporting (typed failure, never fabrication).
 */
export interface SelfHostedProbeTransport {
  probeReadiness(): Promise<{ readonly phase: SelfHostedProbePhase }>;
}

// ---------------------------------------------------------------------------
// The adapter configuration
// ---------------------------------------------------------------------------

export interface SelfHostedAdapterConfig {
  /** The opaque neutral adapter reference (the composition binding key). */
  readonly adapterRef: string;
  /**
   * The isolation classes this deployment's runner serves (a
   * deployment fact; default customer-runner).
   */
  readonly servesIsolation?: readonly IsolationLevel[];
  /** The now seam (observations carry the probe instant; tests inject). */
  readonly nowEpochMs?: () => number;
}

/** Map the probe phase onto the neutral readiness ladder (fail closed). */
function mapProbePhase(phase: SelfHostedProbePhase, adapterRef: string): "ready" | "started" {
  if (phase === "ready") {
    return "ready";
  }
  if (phase === "starting") {
    return "started";
  }
  // down: the runner cannot accept work — typed PERMANENT rejection.
  throw new SubstrateAdapterError(
    adapterRef,
    "the self-hosted runner is down and cannot accept work (fail closed)",
    "permanent",
  );
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * Build the self-hosted substrate adapter over an EXISTING
 * `ContainerRuntimeClient` (the governed customer runner / fleet
 * runner REST seam — zero new protocol) with an OPTIONAL health probe
 * for readiness reporting.
 */
export function createSelfHostedAdapter(
  config: SelfHostedAdapterConfig,
  client: ContainerRuntimeClient,
  probe?: SelfHostedProbeTransport,
): SubstrateRuntimeAdapter {
  const adapterRef = validateAdapterRef(config.adapterRef);
  const now = config.nowEpochMs ?? (() => Date.now());
  const servesIsolation = config.servesIsolation ?? (["customer-runner"] as const);

  return {
    adapterRef,
    servesIsolation: [...servesIsolation],
    // The runtime identity rides the wrapped client's own neutral id
    // (evidence surface — never a vendor name).
    runtimeId: client.runtimeId,

    async run(
      configuration: Parameters<ContainerRuntimeClient["run"]>[0],
      options: ContainerRunOptions,
    ): Promise<ContainerRunResult> {
      // Ride the EXISTING seam unchanged — the wrapped client enforces
      // its own run-identity discipline and fail-closed classification.
      return client.run(configuration, options);
    },

    async observeReadiness(request: ReadinessProbeRequest): Promise<ReadinessObservation> {
      if (probe === undefined) {
        // No probe configured: the adapter cannot report readiness —
        // a typed PERMANENT failure, never a fabricated observation.
        throw new SubstrateAdapterError(
          adapterRef,
          "no health probe is configured for this self-hosted runner (readiness cannot be reported; fail closed)",
          "permanent",
        );
      }
      let phase: SelfHostedProbePhase;
      try {
        phase = (await probe.probeReadiness()).phase;
      } catch (error) {
        throw new SubstrateAdapterError(
          adapterRef,
          `self-hosted readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
          "transient",
        );
      }
      const state = mapProbePhase(phase, adapterRef);
      return validateReadinessObservation({
        substrateId: request.substrateId,
        state,
        observedAtEpochMs: now(),
        source: `substrate-probe:${adapterRef}`,
      });
    },
  };
}
