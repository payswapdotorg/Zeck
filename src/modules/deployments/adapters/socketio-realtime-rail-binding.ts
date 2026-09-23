/**
 * Environment binding for the socket.io realtime rail (deployments
 * module adapter; PPR-010 requirement 5 — the composition gate).
 *
 * The established MATERIALIZATION-GATE pattern (the PPR-008/PPR-009
 * precedent, deploy/preview-authorities.ts + the LiveKit rail binding):
 * the ALTERNATE rail binds in the composition ONLY when the
 * environment materializes its set —
 *
 *   - the listen coordinate: ZECK_SOCKETIO_URL       (non-secret)
 *   - the auth secret:      ZECK_SOCKETIO_AUTH_SECRET (credential-shaped,
 *                            materialized from ZECK_SECRET_SOCKETIO_AUTH_SECRET_REF)
 *
 * — and otherwise the composition keeps EXACTLY today's simulated
 * shape (the in-process rail behind the same neutral seam). Both ways
 * are pinned by tests/unit/deployments/socketio-realtime-rail.test.ts.
 *
 * The materialized values NEVER appear in the binding result, a port
 * shape, a log line, or an error message: the bound rail receives an
 * environment-backed credential SOURCE (the adapter materializes
 * inside its own scope, exactly like the mediated vault path), and the
 * binding result carries presence + the non-secret URL only. The
 * non-secret reference binding lives in deploy/manifests/
 * secret-references.json (ZECK_SECRET_SOCKETIO_AUTH_SECRET_REF).
 *
 * The adapter module loads the vendor packages lazily (its first side
 * effect), so the simulated binding never imports vendor code — the
 * self-hosted socket.io server boots only when a bound rail actually
 * performs its first side effect, at the environment's listen
 * coordinate.
 */

import type { RealtimeRail } from "../ports/realtime-rail";
import { createInProcessRealtimeRail } from "./in-process-realtime-rail";
import type {
  SocketIoRailIdempotencyLedger,
  SocketIoRealtimeRail,
  SocketIoRealtimeRailOptions,
} from "./socketio-realtime-rail";
import {
  createEnvironmentSocketIoCredentialSource,
  createSocketIoRealtimeRail,
} from "./socketio-realtime-rail";

/** The env variable names of the socket.io materialization gate. */
export const SOCKETIO_RAIL_ENV_VARIABLES = {
  url: "ZECK_SOCKETIO_URL",
  authSecret: "ZECK_SOCKETIO_AUTH_SECRET",
} as const;

/** The fixed reference of the environment-backed credential source. */
export const SOCKETIO_ENV_CREDENTIAL_REFERENCE = "env-socketio-credential-set";

/** The environment-materialized socket.io credential set (presence only). */
export interface SocketIoRailMaterialization {
  readonly materialized: boolean;
  /** Which pieces were absent (never which values were present). */
  readonly missing: readonly string[];
  /** The listen coordinate (non-secret; null when unmaterialized). */
  readonly url: string | null;
}

export interface SocketIoRailEnvironmentBinding {
  /** The bound rail — the real alternate, or exactly today's simulated one. */
  readonly rail: RealtimeRail;
  readonly binding: "socketio" | "simulated";
  /** The real binding's listen coordinate (non-secret); null when simulated. */
  readonly socketIoUrl: string | null;
  /** The gate's honest state (which pieces were absent, never values). */
  readonly missing: readonly string[];
  /** True when the bound rail is the REAL socket.io rail. */
  readonly isRealRail: boolean;
}

/**
 * Read the socket.io credential-set materialization from one
 * environment. Values are read ONLY to decide presence; they are never
 * returned, copied or reported.
 */
export function readSocketIoRailMaterialization(
  env: Readonly<Record<string, string | undefined>>,
): SocketIoRailMaterialization {
  const missing: string[] = [];
  const url = env[SOCKETIO_RAIL_ENV_VARIABLES.url]?.trim() ?? "";
  const authSecret = env[SOCKETIO_RAIL_ENV_VARIABLES.authSecret]?.trim() ?? "";
  if (url.length === 0) {
    missing.push(SOCKETIO_RAIL_ENV_VARIABLES.url);
  }
  if (authSecret.length === 0) {
    missing.push(SOCKETIO_RAIL_ENV_VARIABLES.authSecret);
  }
  return {
    materialized: missing.length === 0,
    missing,
    url: missing.length === 0 ? url : null,
  };
}

/**
 * Bind the environment's ALTERNATE realtime rail: the REAL embedded
 * socket.io rail when the credential set materializes, otherwise
 * EXACTLY today's simulated in-process rail (the same neutral seam,
 * the same semantics — the conformance contract makes them
 * interchangeable). The composition-level preference/rebind policy
 * between the primary and the alternate rail is EXPLICITLY OUT OF
 * SCOPE (PPR-010's recorded residual): this gate binds one rail, it
 * never auto-fails-over.
 */
export function bindEnvironmentSocketIoRail(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    /** The neutral channel kinds the real binding serves. */
    readonly channelKinds?: readonly string[];
    /** The adapter-side idempotency ledger for the real binding. */
    readonly ledger?: SocketIoRailIdempotencyLedger;
    /** Extra adapter options passthrough (clock, timeouts; tests). */
    readonly now?: SocketIoRealtimeRailOptions["now"];
  } = {},
): SocketIoRailEnvironmentBinding {
  const materialization = readSocketIoRailMaterialization(env);
  if (!materialization.materialized || materialization.url === null) {
    return {
      rail: createInProcessRealtimeRail(),
      binding: "simulated",
      socketIoUrl: null,
      missing: materialization.missing,
      isRealRail: false,
    };
  }
  const authSecret = env[SOCKETIO_RAIL_ENV_VARIABLES.authSecret]?.trim() ?? "";
  const rail: SocketIoRealtimeRail = createSocketIoRealtimeRail({
    listenUrl: materialization.url,
    channelKinds: options.channelKinds,
    ledger: options.ledger,
    now: options.now,
    credentialSource: createEnvironmentSocketIoCredentialSource({
      reference: SOCKETIO_ENV_CREDENTIAL_REFERENCE,
      connectionId: "env-socketio",
      authSecret,
    }),
  });
  return {
    rail,
    binding: "socketio",
    socketIoUrl: materialization.url,
    missing: [],
    isRealRail: true,
  };
}
