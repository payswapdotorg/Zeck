/**
 * Environment binding for the LiveKit realtime rail (deployments module
 * adapter; PPR-009 requirement 7 — the composition gate).
 *
 * The established MATERIALIZATION-GATE pattern (the PPR-008 precedent,
 * deploy/preview-authorities.ts): a real rail binds in the composition
 * ONLY when the environment materializes the LiveKit credential set —
 *
 *   - the server URL:      ZECK_LIVEKIT_URL        (non-secret)
 *   - the API key:         ZECK_LIVEKIT_API_KEY     (credential-shaped)
 *   - the API secret:      ZECK_LIVEKIT_API_SECRET  (credential-shaped)
 *
 * — and otherwise the composition keeps EXACTLY today's simulated
 * shape (the in-process rail behind the same neutral seam). Both ways
 * are pinned by tests/unit/deployments/livekit-realtime-rail.test.ts.
 *
 * The materialized values NEVER appear in the binding result, a port
 * shape, a log line, or an error message: the bound rail receives an
 * environment-backed credential SOURCE (the adapter materializes
 * inside its own scope, exactly like the mediated vault path), and the
 * binding result carries presence + the non-secret URL only. The
 * non-secret reference bindings live in deploy/manifests/
 * secret-references.json (ZECK_SECRET_LIVEKIT_API_KEY_REF /
 * ZECK_SECRET_LIVEKIT_API_SECRET_REF).
 *
 * The adapter module itself loads the vendor SDK lazily (its first
 * side effect), so the simulated binding never imports vendor code.
 */

import type { RealtimeRail } from "../ports/realtime-rail";
import { createInProcessRealtimeRail } from "./in-process-realtime-rail";
import type {
  LiveKitRailIdempotencyLedger,
  LiveKitRealtimeRail,
  LiveKitRealtimeRailOptions,
} from "./livekit-realtime-rail";
import {
  createEnvironmentLiveKitCredentialSource,
  createLiveKitRealtimeRail,
} from "./livekit-realtime-rail";

/** The env variable names of the LiveKit materialization gate. */
export const LIVEKIT_RAIL_ENV_VARIABLES = {
  url: "ZECK_LIVEKIT_URL",
  apiKey: "ZECK_LIVEKIT_API_KEY",
  apiSecret: "ZECK_LIVEKIT_API_SECRET",
} as const;

/** The fixed reference of the environment-backed credential source. */
export const LIVEKIT_ENV_CREDENTIAL_REFERENCE = "env-livekit-credential-set";

/** The environment-materialized LiveKit credential set (presence only). */
export interface LiveKitRailMaterialization {
  readonly materialized: boolean;
  /** Which pieces were absent (never which values were present). */
  readonly missing: readonly string[];
  /** The server URL (non-secret; null when unmaterialized). */
  readonly url: string | null;
}

export interface RealtimeRailEnvironmentBinding {
  /** The bound rail — the real one, or exactly today's simulated one. */
  readonly rail: RealtimeRail;
  readonly binding: "livekit" | "simulated";
  /** The real binding's server URL (non-secret); null when simulated. */
  readonly liveKitUrl: string | null;
  /** The gate's honest state (which pieces were absent, never values). */
  readonly missing: readonly string[];
  /** True when the bound rail is the REAL LiveKit rail. */
  readonly isRealRail: boolean;
}

/**
 * Read the LiveKit credential-set materialization from one environment.
 * Values are read ONLY to decide presence; they are never returned,
 * copied or reported.
 */
export function readLiveKitRailMaterialization(
  env: Readonly<Record<string, string | undefined>>,
): LiveKitRailMaterialization {
  const missing: string[] = [];
  const url = env[LIVEKIT_RAIL_ENV_VARIABLES.url]?.trim() ?? "";
  const apiKey = env[LIVEKIT_RAIL_ENV_VARIABLES.apiKey]?.trim() ?? "";
  const apiSecret = env[LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]?.trim() ?? "";
  if (url.length === 0) {
    missing.push(LIVEKIT_RAIL_ENV_VARIABLES.url);
  }
  if (apiKey.length === 0) {
    missing.push(LIVEKIT_RAIL_ENV_VARIABLES.apiKey);
  }
  if (apiSecret.length === 0) {
    missing.push(LIVEKIT_RAIL_ENV_VARIABLES.apiSecret);
  }
  return {
    materialized: missing.length === 0,
    missing,
    url: missing.length === 0 ? url : null,
  };
}

/**
 * Bind the environment's realtime rail: the REAL LiveKit rail when the
 * credential set materializes, otherwise EXACTLY today's simulated
 * in-process rail (the same neutral seam, the same semantics — the
 * conformance contract makes them interchangeable).
 */
export function bindEnvironmentRealtimeRail(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    /** The neutral channel kinds the real binding serves. */
    readonly channelKinds?: readonly string[];
    /** The adapter-side idempotency ledger for the real binding. */
    readonly ledger?: LiveKitRailIdempotencyLedger;
    /** Extra adapter options passthrough (clock, timeouts; tests). */
    readonly now?: LiveKitRealtimeRailOptions["now"];
  } = {},
): RealtimeRailEnvironmentBinding {
  const materialization = readLiveKitRailMaterialization(env);
  if (!materialization.materialized || materialization.url === null) {
    return {
      rail: createInProcessRealtimeRail(),
      binding: "simulated",
      liveKitUrl: null,
      missing: materialization.missing,
      isRealRail: false,
    };
  }
  const apiKey = env[LIVEKIT_RAIL_ENV_VARIABLES.apiKey]?.trim() ?? "";
  const apiSecret = env[LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]?.trim() ?? "";
  const rail: LiveKitRealtimeRail = createLiveKitRealtimeRail({
    serverUrl: materialization.url,
    channelKinds: options.channelKinds,
    ledger: options.ledger,
    now: options.now,
    credentialSource: createEnvironmentLiveKitCredentialSource({
      reference: LIVEKIT_ENV_CREDENTIAL_REFERENCE,
      connectionId: "env-livekit",
      apiKey,
      apiSecret,
    }),
  });
  return {
    rail,
    binding: "livekit",
    liveKitUrl: materialization.url,
    missing: [],
    isRealRail: true,
  };
}
