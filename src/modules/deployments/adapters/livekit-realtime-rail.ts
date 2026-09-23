/**
 * LiveKit realtime rail adapter (deployments module adapter; PPR-009 —
 * the FIRST real external `RealtimeRail`).
 *
 * Implements the provider-neutral `RealtimeRail` seam over a REAL
 * LiveKit server through the published, UNMODIFIED `livekit-server-sdk`
 * package (no fork):
 *
 *   - `openSession` maps the neutral session request to an upstream
 *     channel whose NAME is a deterministic opaque hash of the neutral
 *     coordinates (application + stable rail-level idempotency key) —
 *     never user-provided strings verbatim — plus the bounded session
 *     policy (participant ceiling, empty-room timeout);
 *   - `deliverTurn` maps to the channel's reliable data delivery
 *     (bounded preview + artifact reference only — raw media never
 *     crosses, in either direction);
 *   - `transferCall` maps to the channel's agent/handoff pattern (the
 *     escalation frame delivered on the same neutral data semantics);
 *   - `closeSession` maps to the upstream channel teardown.
 *
 * ALL vendor types (the SDK client, the access-token builder, the grant
 * and data-packet shapes) stay INSIDE this file: the port sees only
 * neutral shapes, and nothing vendor-shaped is exported (verified by
 * tests/unit/deployments/livekit-realtime-rail.test.ts).
 *
 * CREDENTIAL MATERIALIZATION (the connections secret-mediation pattern,
 * exactly like connections-realtime-secret-mediation.ts): this adapter
 * NEVER receives plaintext credentials. It holds a credential SOURCE —
 * a reference resolver plus a vault materializer — and materializes the
 * LiveKit API keypair INSIDE its own scope, immediately before the
 * upstream call, only after the frozen admission order (policy →
 * capability → budget → secret mediation → adapter call) has already
 * run in the session service. The `authorization` record handed to the
 * vault derives from the rail-level idempotency key (the dispatch
 * identity of the effect being performed). The materialized plaintext
 * NEVER appears in a port shape, a rail acknowledgment, a log line, or
 * a test fixture.
 *
 * IDEMPOTENCY — WHICH MECHANISM WHERE (PPR-009 requirement 4):
 *   - OPEN and CLOSE converge WITHOUT any adapter ledger across full
 *     process crashes, because the upstream channel's NAME is a
 *     deterministic function of the stable key: `openSession` first
 *     asks the server whether the channel already exists (converged
 *     open, `replayed: true`, NO second channel — the crash-replay
 *     proof), and `closeSession` maps an already-absent channel to the
 *     converged close. This is the LiveKit server's own room-identity
 *     semantics doing the work.
 *   - DELIVERY and TRANSFER (data-channel effects) have NO server-side
 *     idempotency-key semantics in the open-source LiveKit server, so
 *     the ADAPTER's key ledger is the dedupe mechanism: the shipped
 *     default is an in-memory ledger (survives retries and replays for
 *     the adapter process's lifetime, exactly like the simulated
 *     rail's ledger models the provider world); a durable ledger
 *     binding is the composition's concern and is recorded as the
 *     honest boundary in deploy/evidence/ppr-009.json. A refusal is
 *     never cached under a key — a retry under the same key may
 *     succeed.
 *
 * THE SHORT-LIVED CLIENT-ACCESS SEAM (PPR-009 requirement 3): the
 * adapter's public surface exposes `mintClientAccess` — a bounded
 * issuance of a SHORT-LIVED (minutes, never hours; ≤ the session
 * policy's duration ceiling) single-purpose (join, not administer)
 * client access grant carrying the opaque channel ref. The grant value
 * is vendor material by nature, but the DESCRIPTOR it rides in is
 * vendor-neutral (`RealtimeRailClientAccess`) so the session service
 * can project it without importing anything vendor-shaped. The seam
 * derives ONLY from an open, admitted rail session: it fails closed
 * (POLICY_DENIED) for a channel the rail never opened — the open
 * itself is the proof the frozen admission order ran.
 *
 * HONEST AVAILABILITY: this adapter is verified ONLY against a LOCAL
 * open-source livekit-server (label `local-livekit-server`) in this
 * repository's conformance/integration suites. NO managed/production
 * LiveKit availability is claimed or implied anywhere; every
 * external/managed boundary is owned by a Lead credentialed run
 * (deploy/evidence/ppr-009.json notRun registry).
 */

import { createHash } from "node:crypto";
import type { ErrorCode } from "../../../shared/errors";
import { PlatformError } from "../../../shared/errors";
import type { CredentialMaterializer } from "../../connections/public";
import type {
  RealtimeRailDelivery,
  RealtimeRailDeliveryOutcome,
  RealtimeRailDescriptor,
  RealtimeRailSession,
  RealtimeRailSessionRequest,
} from "../ports/realtime-rail";

// ---------------------------------------------------------------------------
// Vendor confinement: type-only imports plus ONE lazy runtime import.
// Nothing vendor-shaped is exported from this file.
// ---------------------------------------------------------------------------

import type {
  AccessToken as LiveKitAccessToken,
  RoomServiceClient as LiveKitRoomServiceClient,
} from "livekit-server-sdk";

/** The livekit-server-sdk module, loaded lazily on first side effect. */
type LiveKitServerSdkModule = typeof import("livekit-server-sdk");

/** The neutral rail identity this adapter binds (the openrouter precedent). */
export const LIVEKIT_RAIL_CAPABILITY_ID = "livekit-realtime-rail";

/**
 * The honest label of the LOCAL open-source server proof (PPR-009): the
 * conformance evidence's subject is a loopback livekit-server in --dev
 * mode with the PUBLIC development keypair — never a managed service.
 */
export const LOCAL_LIVEKIT_SERVER_LABEL = "local-livekit-server";

/** The channel kinds a plain self-hosted server serves without SIP trunks. */
export const LIVEKIT_RAIL_DEFAULT_CHANNEL_KINDS: readonly string[] = ["web", "in-app"];

/** The hard ceiling for any client-access grant (one hour, absolute). */
export const CLIENT_ACCESS_HARD_CEILING_SECONDS = 3600;

/** The default client-access TTL (ten minutes — minutes, not hours). */
export const CLIENT_ACCESS_DEFAULT_TTL_SECONDS = 600;

/** The bounded preview the adapter forwards upstream (port discipline). */
const MAX_UPSTREAM_PREVIEW_CHARS = 512;

// ---------------------------------------------------------------------------
// The credential source (the secret-mediation pattern, adapter side).
// ---------------------------------------------------------------------------

/** The credential envelope the vault materializes for a LiveKit channel. */
interface MaterializedRailCredential {
  readonly apiKey: string;
  readonly apiSecret: string;
}

/** The session-scope hint the credential source resolves references by. */
interface CredentialScope {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly channelKind: string;
  /** The dispatch identity of the effect being performed (the vault's authorization record). */
  readonly attemptId: string;
}

/**
 * Where the adapter's credential references come from and how plaintext
 * is redeemed — composition-bound, never port-carried. `materialize`
 * must be the connections vault's dispatch-path materialization (or an
 * equivalent fail-closed source like the environment binding).
 */
export interface LiveKitRailCredentialSource {
  /**
   * Resolve the rail channel's credential reference for one session
   * scope. Returns null when no credential is bound (fail closed).
   */
  resolve(scope: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly channelKind: string;
  }): Promise<{ readonly connectionId: string; readonly credentialRef: string } | null>;
  /** Redeem the reference's plaintext inside the adapter's scope. */
  readonly materialize: CredentialMaterializer["materialize"];
}

/**
 * An environment-backed credential source (the PPR-008 materialization
 * pattern): a FIXED reference whose plaintext is the materialized
 * environment credential set. For the mediated/production path, bind a
 * source that resolves through the connections catalog instead.
 */
export function createEnvironmentLiveKitCredentialSource(envelope: {
  readonly reference: string;
  readonly connectionId: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}): LiveKitRailCredentialSource {
  const plaintext = JSON.stringify({ apiKey: envelope.apiKey, apiSecret: envelope.apiSecret });
  return {
    async resolve() {
      return { connectionId: envelope.connectionId, credentialRef: envelope.reference };
    },
    async materialize(reference, authorization) {
      if (reference !== envelope.reference) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "the realtime rail credential source refuses an unknown reference",
        });
      }
      void authorization;
      return { reference, plaintext };
    },
  };
}

// ---------------------------------------------------------------------------
// The idempotency ledger (deliver/transfer dedupe; see header).
// ---------------------------------------------------------------------------

export type LiveKitRailEffectKind = "open" | "deliver" | "transfer" | "close";

/** The stored canonical acknowledgment for one side-effect key. */
export interface StoredLiveKitRailAcknowledgment {
  readonly channelSessionRef?: string;
  readonly channelEpoch?: number;
  readonly railMetadata?: Readonly<Record<string, unknown>>;
  readonly deliveredAt: string;
}

/** The adapter-side idempotency ledger (dedupe + ack storage). */
export interface LiveKitRailIdempotencyLedger {
  lookup(
    kind: LiveKitRailEffectKind,
    applicationId: string,
    idempotencyKey: string,
  ): Promise<StoredLiveKitRailAcknowledgment | null>;
  remember(
    kind: LiveKitRailEffectKind,
    applicationId: string,
    idempotencyKey: string,
    ack: StoredLiveKitRailAcknowledgment,
  ): Promise<void>;
}

/** The shipped default: in-memory (see header for the honest boundary). */
export function createInMemoryLiveKitRailIdempotencyLedger(): LiveKitRailIdempotencyLedger {
  const byKey = new Map<string, StoredLiveKitRailAcknowledgment>();
  return {
    async lookup(kind, applicationId, idempotencyKey) {
      return byKey.get(`${kind}:${applicationId}:${idempotencyKey}`) ?? null;
    },
    async remember(kind, applicationId, idempotencyKey, ack) {
      byKey.set(`${kind}:${applicationId}:${idempotencyKey}`, ack);
    },
  };
}

// ---------------------------------------------------------------------------
// Failure normalization (PPR-009 requirement 4 — the exported table).
// ---------------------------------------------------------------------------

export type LiveKitFailureKind =
  | "unreachable"
  | "authentication"
  | "not-found"
  | "quota"
  | "upstream-error";

export interface LiveKitFailureClassification {
  readonly kind: LiveKitFailureKind;
  /** Whether retrying the same logical effect may succeed. */
  readonly retryable: boolean;
  /** The neutral reason vocabulary (never a vendor error string). */
  readonly reason: string;
  /** The provider-neutral error code for a thrown open failure. */
  readonly code: ErrorCode;
}

/**
 * The neutral failure vocabulary every LiveKit failure mode maps onto.
 * Vendor error strings, SDK identifiers and transport codes NEVER cross
 * the seam — only these reasons do.
 */
export const LIVEKIT_FAILURE_NORMALIZATION: Readonly<
  Record<LiveKitFailureKind, Omit<LiveKitFailureClassification, "kind">>
> = {
  unreachable: {
    retryable: true,
    reason: "realtime rail upstream unreachable",
    code: "CAPABILITY_UNAVAILABLE",
  },
  authentication: {
    retryable: false,
    reason: "realtime rail credential rejected by the upstream",
    code: "AUTHENTICATION_FAILED",
  },
  "not-found": {
    retryable: false,
    reason: "realtime rail channel not found upstream",
    code: "PROVIDER_ERROR",
  },
  quota: {
    retryable: true,
    reason: "realtime rail upstream capacity exhausted",
    code: "CAPABILITY_UNAVAILABLE",
  },
  "upstream-error": {
    retryable: false,
    reason: "realtime rail upstream refused the effect",
    code: "PROVIDER_ERROR",
  },
};

const NETWORK_FAILURE_PATTERN =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|fetch failed|network|socket|dial/i;

/**
 * Classify one vendor failure into the neutral vocabulary. Pure: no
 * side effects, no logging, no vendor string propagation.
 */
export function classifyLiveKitFailure(error: unknown): LiveKitFailureClassification {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number") {
    if (status === 401 || status === 403) {
      return { kind: "authentication", ...LIVEKIT_FAILURE_NORMALIZATION.authentication };
    }
    if (status === 404) {
      return { kind: "not-found", ...LIVEKIT_FAILURE_NORMALIZATION["not-found"] };
    }
    if (status === 429 || status === 503) {
      return { kind: "quota", ...LIVEKIT_FAILURE_NORMALIZATION.quota };
    }
    if (status >= 500) {
      return { kind: "unreachable", ...LIVEKIT_FAILURE_NORMALIZATION.unreachable };
    }
    return { kind: "upstream-error", ...LIVEKIT_FAILURE_NORMALIZATION["upstream-error"] };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_FAILURE_PATTERN.test(message)) {
    return { kind: "unreachable", ...LIVEKIT_FAILURE_NORMALIZATION.unreachable };
  }
  return { kind: "upstream-error", ...LIVEKIT_FAILURE_NORMALIZATION["upstream-error"] };
}

// ---------------------------------------------------------------------------
// Opaque, non-PII coordinate derivation (PPR-009 requirement 2).
// ---------------------------------------------------------------------------

function hexDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The upstream channel name: a deterministic opaque hash of the stable
 * coordinates (application + rail-level idempotency key). NEVER
 * user-provided strings verbatim; stable across retries, crashes and
 * fresh adapter processes (this is what makes opens crash-convergent).
 */
export function liveKitUpstreamChannelNameOf(
  applicationId: string,
  idempotencyKey: string,
): string {
  return `zeckrt-${hexDigest(`channel:${applicationId}:${idempotencyKey}`).slice(0, 24)}`;
}

/**
 * The neutral channel-session ref the port sees: opaque, non-PII,
 * derived from the same stable coordinates (a DIFFERENT hash domain,
 * so no vendor identifier is derivable from the port's ref, and vice
 * versa).
 */
export function liveKitChannelSessionRefOf(
  applicationId: string,
  idempotencyKey: string,
  channelKind: string,
): string {
  return `rtch-${hexDigest(`ref:${applicationId}:${idempotencyKey}:${channelKind}`).slice(0, 24)}`;
}

/** The opaque, non-PII participant identity for a client-access grant. */
function participantIdentityOf(
  applicationId: string,
  channelSessionRef: string,
  participantRef: string | null,
): string {
  return `zcp-${hexDigest(`participant:${applicationId}:${channelSessionRef}:${participantRef ?? "anonymous"}`).slice(0, 20)}`;
}

function clampDurationSeconds(maxSessionDurationMs: number): number {
  const seconds = Math.ceil(maxSessionDurationMs / 1000);
  return Math.min(Math.max(seconds, 60), 21_600);
}

/**
 * The client-access TTL: never above the session policy's duration
 * ceiling, never above the one-hour hard ceiling, never below one
 * second, defaulting MINUTES (600s), not hours.
 */
export function clientAccessTtlOf(maxSessionDurationMs: number, defaultTtlSeconds: number): number {
  const policyCeilingSeconds = Math.ceil(maxSessionDurationMs / 1000);
  return Math.max(
    1,
    Math.min(defaultTtlSeconds, policyCeilingSeconds, CLIENT_ACCESS_HARD_CEILING_SECONDS),
  );
}

// ---------------------------------------------------------------------------
// The short-lived client-access seam (PPR-009 requirement 3).
// ---------------------------------------------------------------------------

/** The neutral client-access request (no vendor shapes). */
export interface RealtimeRailClientAccessRequest {
  readonly applicationId: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  /** The bounded session policy the grant's TTL must respect. */
  readonly sessionPolicy: {
    readonly maxSessionDurationMs: number;
    readonly maxConcurrentSessions: number;
  };
  /** Optional caller-side participant discriminator (opaque). */
  readonly participantRef: string | null;
}

/**
 * The vendor-neutral client-access descriptor the session service can
 * project: what it is for (join), which channel, how long it lives.
 * The `grant` string is the opaque short-lived credential the browser
 * redeems — vendor material by nature, confined to this field.
 */
export interface RealtimeRailClientAccess {
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly purpose: "join";
  readonly ttlSeconds: number;
  readonly expiresAt: string;
  readonly grant: string;
}

// ---------------------------------------------------------------------------
// The adapter's observable surface (test/operator observability only).
// ---------------------------------------------------------------------------

/** One recorded upstream side effect actually performed (the observable). */
export interface LiveKitRailEffectRecord {
  readonly kind: LiveKitRailEffectKind;
  readonly applicationId: string;
  readonly sessionId: string | null;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly routeClass: string | null;
  readonly idempotencyKey: string;
  readonly cause: string | null;
  readonly at: string;
}

export interface LiveKitRealtimeRailOptions {
  /** The upstream server base URL (e.g. a local server on loopback). */
  readonly serverUrl: string;
  /** The composition-bound credential source (never plaintext). */
  readonly credentialSource: LiveKitRailCredentialSource;
  /** The neutral channel kinds this binding serves. */
  readonly channelKinds?: readonly string[];
  /** The adapter-side idempotency ledger (defaults to in-memory). */
  readonly ledger?: LiveKitRailIdempotencyLedger;
  /** The clock (tests); defaults to the system clock. */
  readonly now?: () => Date;
  /** The default client-access TTL (defaults to 600s). */
  readonly clientAccessDefaultTtlSeconds?: number;
  /** Per-request upstream timeout in seconds (defaults to the SDK's). */
  readonly requestTimeoutSeconds?: number;
}

/** The LiveKit realtime rail: the port plus the client-access seam. */
export interface LiveKitRealtimeRail {
  readonly descriptor: RealtimeRailDescriptor;
  openSession(request: RealtimeRailSessionRequest): Promise<RealtimeRailSession>;
  deliverTurn(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome>;
  transferCall(delivery: RealtimeRailDelivery): Promise<RealtimeRailDeliveryOutcome>;
  closeSession(reference: {
    readonly applicationId: string;
    readonly sessionId: string;
    readonly channelSessionRef: string;
    readonly channelEpoch: number;
    readonly idempotencyKey: string;
    readonly cause: string | null;
  }): Promise<RealtimeRailDeliveryOutcome>;
  /** The short-lived client-access seam (see header). */
  mintClientAccess(request: RealtimeRailClientAccessRequest): Promise<RealtimeRailClientAccess>;
  /**
   * The upstream side effects actually performed, in order (converged
   * replays record NOTHING here — exactly-once is the observable).
   */
  readonly upstreamEffects: readonly LiveKitRailEffectRecord[];
}

interface ChannelBinding {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly channelKind: string;
  readonly openIdempotencyKey: string;
  readonly roomName: string;
}

/**
 * Create the LiveKit realtime rail. The SDK module is loaded LAZILY on
 * the first side effect, so an unbound composition never even imports
 * vendor code.
 */
export function createLiveKitRealtimeRail(
  options: LiveKitRealtimeRailOptions,
): LiveKitRealtimeRail {
  const channelKinds = options.channelKinds ?? LIVEKIT_RAIL_DEFAULT_CHANNEL_KINDS;
  const ledger = options.ledger ?? createInMemoryLiveKitRailIdempotencyLedger();
  const now = options.now ?? (() => new Date());
  const serverUrl = normalizeServerUrl(options.serverUrl);
  const effects: LiveKitRailEffectRecord[] = [];
  const channelBindings = new Map<string, ChannelBinding>();
  const closedChannelRefs = new Set<string>();
  let sdkModule: LiveKitServerSdkModule | null = null;
  let serviceClient: LiveKitRoomServiceClient | null = null;
  let credential: MaterializedRailCredential | null = null;

  async function loadSdk(): Promise<LiveKitServerSdkModule> {
    if (sdkModule === null) {
      sdkModule = (await import("livekit-server-sdk")) as LiveKitServerSdkModule;
    }
    return sdkModule;
  }

  async function materializeCredential(
    scope: CredentialScope,
  ): Promise<MaterializedRailCredential> {
    if (credential !== null) {
      return credential;
    }
    const resolved = await options.credentialSource.resolve(scope);
    if (resolved === null) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message:
          "the realtime rail has no credential source bound for this channel (bind the channel's credential reference before dispatch)",
        retryable: false,
      });
    }
    const materialized = await options.credentialSource.materialize(resolved.credentialRef, {
      attemptId: scope.attemptId,
      connectionId: resolved.connectionId,
    });
    const parsed = parseCredentialEnvelope(materialized.plaintext);
    credential = parsed;
    return parsed;
  }

  async function openClient(scope: CredentialScope): Promise<LiveKitRoomServiceClient> {
    if (serviceClient !== null) {
      return serviceClient;
    }
    const sdk = await loadSdk();
    const materialized = await materializeCredential(scope);
    serviceClient = new sdk.RoomServiceClient(
      serverUrl,
      materialized.apiKey,
      materialized.apiSecret,
      { requestTimeout: options.requestTimeoutSeconds, failover: false },
    );
    return serviceClient;
  }

  function bindingScopeOf(
    applicationId: string,
    channelSessionRef: string,
    attemptId: string,
  ): CredentialScope {
    const binding = channelBindings.get(channelSessionRef);
    if (binding !== undefined && binding.applicationId === applicationId) {
      return {
        applicationId,
        tenantId: binding.tenantId,
        channelKind: binding.channelKind,
        attemptId,
      };
    }
    return { applicationId, tenantId: applicationId, channelKind: "web", attemptId };
  }

  function record(effect: Omit<LiveKitRailEffectRecord, "at">): void {
    effects.push({ ...effect, at: now().toISOString() });
  }

  function throwOpenFailure(error: unknown): never {
    if (error instanceof PlatformError) {
      throw error;
    }
    const classification = classifyLiveKitFailure(error);
    throw new PlatformError({
      code: classification.code,
      message: classification.reason,
      retryable: classification.retryable,
      cause: error,
    });
  }

  function outcomeFailure(error: unknown): RealtimeRailDeliveryOutcome {
    const classification = classifyLiveKitFailure(error);
    return { delivered: false, reason: classification.reason };
  }

  async function sendChannelFrame(
    kind: "deliver" | "transfer",
    frame: RealtimeRailDelivery,
  ): Promise<RealtimeRailDeliveryOutcome> {
    const stored = await ledger.lookup(kind, frame.applicationId, frame.idempotencyKey);
    if (stored !== null) {
      return {
        delivered: true,
        deliveredAt: stored.deliveredAt,
        replayed: true,
        ...(stored.railMetadata === undefined ? {} : { railMetadata: stored.railMetadata }),
      };
    }
    try {
      const binding = channelBindings.get(frame.channelSessionRef);
      const channelName =
        binding !== undefined && binding.applicationId === frame.applicationId
          ? binding.roomName
          : liveKitUpstreamChannelNameOf(frame.applicationId, `ref:${frame.channelSessionRef}`);
      const roomClient = await openClient(
        bindingScopeOf(
          frame.applicationId,
          frame.channelSessionRef,
          `${kind}:${frame.idempotencyKey}`,
        ),
      );
      const sdk = await loadSdk();
      const payload = JSON.stringify({
        kind,
        channelEpoch: frame.channelEpoch,
        routeClass: frame.routeClass,
        responseRef: frame.responseRef,
        responsePreview: frame.responsePreview.slice(0, MAX_UPSTREAM_PREVIEW_CHARS),
        cause: frame.cause,
      });
      await roomClient.sendData(
        channelName,
        new TextEncoder().encode(payload),
        sdk.DataPacket_Kind.RELIABLE,
        { topic: `zeck-${kind}` },
      );
      const deliveredAt = now().toISOString();
      const railMetadata = { routeClass: frame.routeClass };
      await ledger.remember(kind, frame.applicationId, frame.idempotencyKey, {
        deliveredAt,
        railMetadata,
      });
      record({
        kind,
        applicationId: frame.applicationId,
        sessionId: frame.sessionId,
        channelSessionRef: frame.channelSessionRef,
        channelEpoch: frame.channelEpoch,
        routeClass: frame.routeClass,
        idempotencyKey: frame.idempotencyKey,
        cause: frame.cause,
      });
      return { delivered: true, deliveredAt, replayed: false, railMetadata };
    } catch (error) {
      return outcomeFailure(error);
    }
  }

  return {
    descriptor: {
      railCapabilityId: LIVEKIT_RAIL_CAPABILITY_ID,
      channelKinds,
      transportClass: "realtime",
    },

    async openSession(request) {
      const stored = await ledger.lookup("open", request.applicationId, request.idempotencyKey);
      if (stored !== null && stored.channelSessionRef !== undefined) {
        return {
          channelSessionRef: stored.channelSessionRef,
          channelEpoch: stored.channelEpoch ?? 1,
          railMetadata: stored.railMetadata ?? {},
          replayed: true,
        };
      }
      const roomName = liveKitUpstreamChannelNameOf(request.applicationId, request.idempotencyKey);
      const channelSessionRef =
        request.channelSessionRef ??
        liveKitChannelSessionRefOf(
          request.applicationId,
          request.idempotencyKey,
          request.channelKind,
        );
      const railMetadata = {
        channelKind: request.channelKind,
        sessionPolicy: { ...request.sessionPolicy },
      };
      try {
        const roomClient = await openClient({
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          channelKind: request.channelKind,
          attemptId: `open:${request.applicationId}:${request.idempotencyKey}`,
        });
        // Convergence check FIRST: an upstream channel under this exact
        // name is the durable record of a prior open (a crash replay) —
        // converge on it, never create a second one.
        const existing = await roomClient.listRooms([roomName]);
        const converged = existing.length > 0;
        if (!converged) {
          await roomClient.createRoom({
            name: roomName,
            emptyTimeout: clampDurationSeconds(request.sessionPolicy.maxSessionDurationMs),
            maxParticipants: Math.max(request.sessionPolicy.maxConcurrentSessions, 1),
          });
        }
        const session: RealtimeRailSession = {
          channelSessionRef,
          channelEpoch: 1,
          railMetadata,
          replayed: converged,
        };
        await ledger.remember("open", request.applicationId, request.idempotencyKey, {
          channelSessionRef,
          channelEpoch: 1,
          railMetadata,
          deliveredAt: now().toISOString(),
        });
        channelBindings.set(channelSessionRef, {
          applicationId: request.applicationId,
          tenantId: request.tenantId,
          channelKind: request.channelKind,
          openIdempotencyKey: request.idempotencyKey,
          roomName,
        });
        if (!converged) {
          record({
            kind: "open",
            applicationId: request.applicationId,
            sessionId: null,
            channelSessionRef,
            channelEpoch: 1,
            routeClass: null,
            idempotencyKey: request.idempotencyKey,
            cause: null,
          });
        }
        return session;
      } catch (error) {
        throwOpenFailure(error);
      }
    },

    async deliverTurn(frame) {
      return sendChannelFrame("deliver", frame);
    },

    async transferCall(frame) {
      return sendChannelFrame("transfer", frame);
    },

    async closeSession(reference) {
      const stored = await ledger.lookup(
        "close",
        reference.applicationId,
        reference.idempotencyKey,
      );
      if (stored !== null) {
        return { delivered: true, deliveredAt: stored.deliveredAt, replayed: true };
      }
      const binding = channelBindings.get(reference.channelSessionRef);
      const roomName =
        binding !== undefined && binding.applicationId === reference.applicationId
          ? binding.roomName
          : liveKitUpstreamChannelNameOf(
              reference.applicationId,
              `ref:${reference.channelSessionRef}`,
            );
      try {
        const roomClient = await openClient(
          bindingScopeOf(
            reference.applicationId,
            reference.channelSessionRef,
            `close:${reference.idempotencyKey}`,
          ),
        );
        let converged = false;
        try {
          await roomClient.deleteRoom(roomName);
        } catch (error) {
          const classification = classifyLiveKitFailure(error);
          if (classification.kind === "not-found") {
            // The upstream already holds the post-close state (a prior
            // close, or a crashed process's close that completed): the
            // converged close, never a fabricated fresh effect.
            converged = true;
          } else {
            throw error;
          }
        }
        const deliveredAt = now().toISOString();
        await ledger.remember("close", reference.applicationId, reference.idempotencyKey, {
          deliveredAt,
        });
        closedChannelRefs.add(reference.channelSessionRef);
        channelBindings.delete(reference.channelSessionRef);
        if (!converged) {
          record({
            kind: "close",
            applicationId: reference.applicationId,
            sessionId: reference.sessionId,
            channelSessionRef: reference.channelSessionRef,
            channelEpoch: reference.channelEpoch,
            routeClass: null,
            idempotencyKey: reference.idempotencyKey,
            cause: reference.cause,
          });
        }
        return {
          delivered: true,
          deliveredAt,
          replayed: converged,
          ...(converged ? { railMetadata: { converged: true } } : {}),
        };
      } catch (error) {
        return outcomeFailure(error);
      }
    },

    async mintClientAccess(request) {
      const binding = channelBindings.get(request.channelSessionRef);
      if (binding === undefined || binding.applicationId !== request.applicationId) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message:
            "client access derives only from an open, admitted rail session (the channel was not opened through this rail)",
          retryable: false,
        });
      }
      if (closedChannelRefs.has(request.channelSessionRef)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: "client access cannot be minted for a closed rail channel",
          retryable: false,
        });
      }
      const ttlSeconds = clientAccessTtlOf(
        request.sessionPolicy.maxSessionDurationMs,
        options.clientAccessDefaultTtlSeconds ?? CLIENT_ACCESS_DEFAULT_TTL_SECONDS,
      );
      const sdk = await loadSdk();
      const materialized = await materializeCredential({
        applicationId: request.applicationId,
        tenantId: binding.tenantId,
        channelKind: binding.channelKind,
        attemptId: `client-access:${request.channelSessionRef}`,
      });
      const token: LiveKitAccessToken = new sdk.AccessToken(
        materialized.apiKey,
        materialized.apiSecret,
        {
          ttl: ttlSeconds,
          identity: participantIdentityOf(
            request.applicationId,
            request.channelSessionRef,
            request.participantRef,
          ),
        },
      );
      // SINGLE-PURPOSE (join, not administer): roomJoin only — no
      // roomCreate/roomList/roomAdmin/roomRecord grants at all.
      token.addGrant({
        room: binding.roomName,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canUpdateOwnMetadata: false,
        hidden: false,
        recorder: false,
      });
      const grant = await token.toJwt();
      return {
        channelSessionRef: request.channelSessionRef,
        channelEpoch: request.channelEpoch,
        purpose: "join",
        ttlSeconds,
        expiresAt: new Date(now().getTime() + ttlSeconds * 1000).toISOString(),
        grant,
      };
    },

    get upstreamEffects() {
      return effects;
    },
  };
}

function parseCredentialEnvelope(plaintext: string): MaterializedRailCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "the realtime rail credential material is not a valid credential envelope",
      retryable: false,
    });
  }
  const record = parsed as { apiKey?: unknown; apiSecret?: unknown };
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.apiKey !== "string" ||
    typeof record.apiSecret !== "string" ||
    record.apiKey.length === 0 ||
    record.apiSecret.length === 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "the realtime rail credential envelope is missing its keypair members",
      retryable: false,
    });
  }
  return { apiKey: record.apiKey, apiSecret: record.apiSecret };
}

function normalizeServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (trimmed.startsWith("ws://")) {
    return `http://${trimmed.slice(5)}`;
  }
  if (trimmed.startsWith("wss://")) {
    return `https://${trimmed.slice(6)}`;
  }
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return `http://${trimmed}`;
  }
  return trimmed;
}
