/**
 * socket.io realtime rail adapter (deployments module adapter; PPR-010 —
 * the ALTERNATE REAL external `RealtimeRail`).
 *
 * Implements the provider-neutral `RealtimeRail` seam over the
 * published, UNMODIFIED `socket.io` server package (4.8.x, no fork),
 * EMBEDDING a real socket.io server in process (the honest self-hosted
 * form — the binding's `ZECK_SOCKETIO_URL` is the listen/attach
 * coordinate):
 *
 *   - `openSession` maps the neutral session request to a server-side
 *     socket.io room whose NAME is a deterministic opaque hash of the
 *     neutral coordinates (application + stable rail-level idempotency
 *     key) — never user-provided strings verbatim — plus the bounded
 *     session policy (join ceiling, empty-room expiry);
 *   - `deliverTurn` maps to the room emit WITH the ack callback — the
 *     upstream's real answer (the connected receivers'
 *     acknowledgments), never fabricated; an empty room completes the
 *     broadcast vacuously (exactly like publishing to a LiveKit room
 *     with no participants), while receivers that fail to acknowledge
 *     within the bounded window fail honestly (`no-receiver`);
 *   - `transferCall` maps to the adapter's handoff pattern (the PPR-009
 *     precedent — socket.io has no native transfer either; the frame is
 *     re-tagged and moved under the same key discipline);
 *   - `closeSession` maps to the room close + connected-socket
 *     disconnect + ledger record.
 *
 * THE ADAPTER IS A PRIVILEGED AUTHORITY OVER THE EMBEDDED SERVER: it
 * boots the server, installs the rail protocol (the grant-verifying
 * handshake middleware + the channel registry + the rail event
 * handlers), and performs every upstream side effect through a REAL
 * dispatch connection — a real socket.io client over loopback
 * WebSocket, authenticated by a short-lived signed dispatch grant
 * derived from the materialized auth secret. The port sees only
 * neutral shapes; ALL socket.io/engine.io types stay INSIDE this file
 * and nothing vendor-shaped is exported (verified by
 * tests/unit/deployments/socketio-realtime-rail.test.ts).
 *
 * THE SHORT-LIVED CLIENT-ACCESS SEAM (PPR-010 requirement 2): the
 * adapter's public surface exposes `mintClientAccess` — a bounded
 * issuance of a SHORT-LIVED (minutes, never hours; ≤ the session
 * policy's duration ceiling) single-purpose (join, not administer)
 * join grant (the socket.io handshake auth payload) carrying the opaque
 * channel ref. The grant descriptor is vendor-neutral
 * (`SocketIoRailClientAccess`) so the session service can project it
 * without importing anything vendor-shaped. The seam derives ONLY from
 * an open, admitted rail session — it fails closed (POLICY_DENIED) for
 * a channel the rail never opened.
 *
 * CREDENTIAL MATERIALIZATION (the connections secret-mediation
 * pattern): this adapter NEVER receives plaintext credentials. It holds
 * a credential SOURCE — a reference resolver plus a vault materializer —
 * and materializes the rail's auth secret INSIDE its own scope,
 * immediately before the first side effect, only after the frozen
 * admission order (policy → capability → budget → secret mediation →
 * adapter call) has already run in the session service. The
 * materialized plaintext NEVER appears in a port shape, a rail
 * acknowledgment, a log line, or a test fixture.
 *
 * IDEMPOTENCY — WHICH MECHANISM WHERE (the PPR-009 discipline):
 *   - OPEN and CLOSE converge WITHOUT any adapter ledger across full
 *     ADAPTER crashes, because the channel's room NAME is a
 *     deterministic function of the stable key and the channel registry
 *     lives SERVER-side (the embedded server — or any socket.io server
 *     the adapter attaches to — survives the adapter instance): a
 *     re-open asks the server whether the channel exists (converged
 *     open, `replayed: true`, NO second channel), and a close of an
 *     already-absent channel maps to the converged close.
 *   - DELIVERY and TRANSFER (room-emit effects) converge through the
 *     ADAPTER's in-memory key ledger (the fast path) AND the server
 *     registry's own key semantics (the upstream truth — the embedded
 *     rail protocol never re-emits a room frame under a key it has
 *     already completed). The shipped adapter ledger default is
 *     in-memory; a durable ledger binding is the composition's concern
 *     and is recorded as the honest boundary in
 *     deploy/evidence/ppr-010.json. A refusal is never cached under a
 *     key — a retry under the same key may succeed.
 *
 * HONEST AVAILABILITY: this adapter is verified ONLY against its own
 * LOCAL embedded socket.io server (label `local-socketio-server`) in
 * this repository's conformance/integration suites — real loopback
 * WebSockets, real handshakes, real acknowledgments, but all inside the
 * test process's machine. NO external/managed socket.io availability is
 * claimed or implied anywhere; every external boundary is owned by a
 * Lead credentialed run (deploy/evidence/ppr-010.json notRun registry).
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
// Vendor confinement: type-only imports plus TWO lazy runtime imports
// (the server package AND the dispatch client package). Nothing
// vendor-shaped is exported from this file.
// ---------------------------------------------------------------------------

import type { Server as SocketIoServer, Socket as SocketIoServerSocket } from "socket.io";
import type { Socket as SocketIoClientSocket } from "socket.io-client";

/** The neutral rail identity this adapter binds (the openrouter precedent). */
export const SOCKETIO_RAIL_CAPABILITY_ID = "socketio-realtime-rail";

/**
 * The honest label of the LOCAL embedded-server proof (PPR-010): the
 * conformance evidence's subject is a real in-process socket.io server
 * on loopback — never an external or managed service.
 */
export const LOCAL_SOCKETIO_SERVER_LABEL = "local-socketio-server";

/** The channel kinds a plain self-hosted socket.io server serves. */
export const SOCKETIO_RAIL_DEFAULT_CHANNEL_KINDS: readonly string[] = ["web", "in-app"];

/** The hard ceiling for any client-access grant (one hour, absolute). */
export const SOCKETIO_CLIENT_ACCESS_HARD_CEILING_SECONDS = 3600;

/** The default client-access TTL (ten minutes — minutes, not hours). */
export const SOCKETIO_CLIENT_ACCESS_DEFAULT_TTL_SECONDS = 600;

/** The bounded preview the adapter forwards upstream (port discipline). */
const MAX_UPSTREAM_PREVIEW_CHARS = 512;

/** The engine.io path the embedded rail server serves. */
export const SOCKETIO_RAIL_PATH = "/zeckrt/";

/** The default bounded per-effect window (dispatch + room acknowledgment). */
export const SOCKETIO_RAIL_DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/** The dispatch grant TTL (re-signed on every connection attempt). */
const DISPATCH_GRANT_TTL_SECONDS = 600;

/** The empty-room sweep cadence (mirrors the server's own sweep loops). */
const CHANNEL_SWEEP_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// The credential source (the secret-mediation pattern, adapter side).
// ---------------------------------------------------------------------------

/** The credential envelope the vault materializes for the rail. */
interface MaterializedRailCredential {
  readonly authSecret: string;
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
export interface SocketIoRailCredentialSource {
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
export function createEnvironmentSocketIoCredentialSource(envelope: {
  readonly reference: string;
  readonly connectionId: string;
  readonly authSecret: string;
}): SocketIoRailCredentialSource {
  const plaintext = JSON.stringify({ authSecret: envelope.authSecret });
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

export type SocketIoRailEffectKind = "open" | "deliver" | "transfer" | "close";

/** The stored canonical acknowledgment for one side-effect key. */
export interface StoredSocketIoRailAcknowledgment {
  readonly channelSessionRef?: string;
  readonly channelEpoch?: number;
  readonly railMetadata?: Readonly<Record<string, unknown>>;
  readonly deliveredAt: string;
}

/** The adapter-side idempotency ledger (dedupe + ack storage). */
export interface SocketIoRailIdempotencyLedger {
  lookup(
    kind: SocketIoRailEffectKind,
    applicationId: string,
    idempotencyKey: string,
  ): Promise<StoredSocketIoRailAcknowledgment | null>;
  remember(
    kind: SocketIoRailEffectKind,
    applicationId: string,
    idempotencyKey: string,
    ack: StoredSocketIoRailAcknowledgment,
  ): Promise<void>;
}

/** The shipped default: in-memory (see header for the honest boundary). */
export function createInMemorySocketIoRailIdempotencyLedger(): SocketIoRailIdempotencyLedger {
  const byKey = new Map<string, StoredSocketIoRailAcknowledgment>();
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
// Failure normalization (the exported table — the LiveKit precedent).
// ---------------------------------------------------------------------------

export type SocketIoFailureKind =
  | "unreachable"
  | "authentication"
  | "not-found"
  | "quota"
  | "no-receiver"
  | "upstream-error";

export interface SocketIoFailureClassification {
  readonly kind: SocketIoFailureKind;
  /** Whether retrying the same logical effect may succeed. */
  readonly retryable: boolean;
  /** The neutral reason vocabulary (never a vendor error string). */
  readonly reason: string;
  /** The provider-neutral error code for a thrown open failure. */
  readonly code: ErrorCode;
}

/**
 * The neutral failure vocabulary every socket.io failure mode maps
 * onto. The first five kinds share the LiveKit table's EXACT reason
 * strings (the substitution drill's shared-vocabulary invariant); the
 * sixth (`no-receiver`) is the socket.io seam's own honest condition —
 * a room emit whose present receivers failed to acknowledge within the
 * bounded window (an EMPTY room completes the broadcast vacuously, the
 * same semantics as publishing to a room with no participants). Vendor
 * error strings, SDK identifiers and transport codes NEVER cross the
 * seam — only these reasons do.
 */
export const SOCKETIO_FAILURE_NORMALIZATION: Readonly<
  Record<SocketIoFailureKind, Omit<SocketIoFailureClassification, "kind">>
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
  "no-receiver": {
    retryable: true,
    reason: "realtime rail channel has no connected receiver for the delivery",
    code: "CAPABILITY_UNAVAILABLE",
  },
  "upstream-error": {
    retryable: false,
    reason: "realtime rail upstream refused the effect",
    code: "PROVIDER_ERROR",
  },
};

const NETWORK_FAILURE_PATTERN =
  /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EPIPE|fetch failed|network|socket|dial|websocket|timed ?out/i;

const AUTH_FAILURE_PATTERN = /grant|unauthorized|forbidden|handshake|credential/i;

/**
 * Classify one vendor failure into the neutral vocabulary. Pure: no
 * side effects, no logging, no vendor string propagation. Structured
 * rail-protocol failures (the server's own `{ failure }` answers) map
 * directly; transport-level failures classify by their neutral shape.
 */
export function classifySocketIoFailure(error: unknown): SocketIoFailureClassification {
  const failure = (error as { failure?: unknown } | null | undefined)?.failure;
  if (typeof failure === "string" && failure in SOCKETIO_FAILURE_NORMALIZATION) {
    const kind = failure as SocketIoFailureKind;
    return { kind, ...SOCKETIO_FAILURE_NORMALIZATION[kind] };
  }
  const status = (error as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number") {
    if (status === 401 || status === 403) {
      return { kind: "authentication", ...SOCKETIO_FAILURE_NORMALIZATION.authentication };
    }
    if (status === 404) {
      return { kind: "not-found", ...SOCKETIO_FAILURE_NORMALIZATION["not-found"] };
    }
    if (status === 429 || status === 503) {
      return { kind: "quota", ...SOCKETIO_FAILURE_NORMALIZATION.quota };
    }
    if (status >= 500) {
      return { kind: "unreachable", ...SOCKETIO_FAILURE_NORMALIZATION.unreachable };
    }
    return { kind: "upstream-error", ...SOCKETIO_FAILURE_NORMALIZATION["upstream-error"] };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (NETWORK_FAILURE_PATTERN.test(message)) {
    return { kind: "unreachable", ...SOCKETIO_FAILURE_NORMALIZATION.unreachable };
  }
  if (AUTH_FAILURE_PATTERN.test(message)) {
    return { kind: "authentication", ...SOCKETIO_FAILURE_NORMALIZATION.authentication };
  }
  return { kind: "upstream-error", ...SOCKETIO_FAILURE_NORMALIZATION["upstream-error"] };
}

// ---------------------------------------------------------------------------
// Opaque, non-PII coordinate derivation (the PPR-009 discipline).
// ---------------------------------------------------------------------------

function hexDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The upstream room name: a deterministic opaque hash of the stable
 * coordinates (application + rail-level idempotency key). NEVER
 * user-provided strings verbatim; stable across retries, crashes and
 * fresh adapter processes (this is what makes opens crash-convergent).
 */
export function socketIoUpstreamChannelNameOf(
  applicationId: string,
  idempotencyKey: string,
): string {
  return `zecksio-${hexDigest(`channel:${applicationId}:${idempotencyKey}`).slice(0, 24)}`;
}

/**
 * The neutral channel-session ref the port sees: opaque, non-PII,
 * derived from the same stable coordinates (a DIFFERENT hash domain,
 * so no vendor identifier is derivable from the port's ref, and vice
 * versa).
 */
export function socketIoChannelSessionRefOf(
  applicationId: string,
  idempotencyKey: string,
  channelKind: string,
): string {
  return `siort-${hexDigest(`ref:${applicationId}:${idempotencyKey}:${channelKind}`).slice(0, 24)}`;
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
export function socketIoClientAccessTtlOf(
  maxSessionDurationMs: number,
  defaultTtlSeconds: number,
): number {
  const policyCeilingSeconds = Math.ceil(maxSessionDurationMs / 1000);
  return Math.max(
    1,
    Math.min(defaultTtlSeconds, policyCeilingSeconds, SOCKETIO_CLIENT_ACCESS_HARD_CEILING_SECONDS),
  );
}

// ---------------------------------------------------------------------------
// The signed grant format (the short-lived, single-purpose credentials).
// ---------------------------------------------------------------------------

/** The grant payload before encoding (vendor-neutral members only). */
interface GrantPayload {
  /** The grant's single purpose: `join` (a session receiver) or `dispatch` (the rail's own authority). */
  readonly p: "join" | "dispatch";
  /** The room the join grant is scoped to (join grants only). */
  readonly r?: string;
  /** The channel-session ref the join grant is scoped to (join grants only). */
  readonly c?: string;
  /** The expiry epoch (milliseconds since the Unix epoch). */
  readonly e: number;
}

function encodeGrantPayload(payload: GrantPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("hex");
}

function signGrant(authSecret: string, payloadHex: string): string {
  return createHmac("sha256", authSecret).update(payloadHex).digest("hex");
}

function verifyGrant(authSecret: string, grant: unknown): GrantPayload | null {
  if (typeof grant !== "string") {
    return null;
  }
  const parts = grant.split(".");
  if (parts.length !== 3 || parts[0] !== "zeckgrant1") {
    return null;
  }
  const payloadHex = parts[1];
  const signature = parts[2];
  if (payloadHex === undefined || signature === undefined) {
    return null;
  }
  const expected = signGrant(authSecret, payloadHex);
  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payloadHex, "hex").toString("utf8")) as GrantPayload;
    if (
      (parsed.p !== "join" && parsed.p !== "dispatch") ||
      typeof parsed.e !== "number" ||
      Number.isNaN(parsed.e)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The embedded rail server host (the honest self-hosted form).
// ---------------------------------------------------------------------------

/** The neutral server-side observation vantage (the probes' truth). */
export interface SocketIoRailServerObservation {
  /** Channels the rail protocol has created (total, monotonic). */
  countChannelsCreated(): number;
  /** Room-emit deliveries the rail protocol completed (acked). */
  countDeliveriesCompleted(): number;
  /** Room-emit transfers the rail protocol completed (acked). */
  countTransfersCompleted(): number;
  /** Channel closes the rail protocol performed. */
  countClosesPerformed(): number;
  /** Channels currently live in the registry. */
  liveChannelCount(): number;
  /** Sockets currently connected to the embedded server. */
  connectedSocketCount(): number;
}

/**
 * A handle to a booted embedded socket.io rail server. The vendor
 * objects stay inside this module; the handle exposes only the neutral
 * control/observation surface (refusal injection, probes, shutdown).
 */
export interface SocketIoRailEmbeddedServer {
  /** The loopback URL the server serves on (e.g. http://127.0.0.1:37891). */
  readonly url: string;
  /** The engine.io path the rail serves on. */
  readonly railPath: string;
  /**
   * Stop serving: close the listener AND destroy every live connection
   * — the embedded server's own REAL "went away" failure mode (new
   * connects get ECONNREFUSED; live sockets see a transport close).
   */
  stopServing(): Promise<void>;
  /** Resume serving on the same coordinate. */
  startServing(): Promise<void>;
  /** Whether the listener is currently open. */
  isServing(): boolean;
  /** The server-side observation vantage (zeros before the rail protocol installs). */
  observe(): SocketIoRailServerObservation;
  /** Full shutdown (the listener, every connection, the socket.io server). */
  close(): Promise<void>;
}

/**
 * The host's own socket.io Server instance, recorded at boot — the
 * identity the rail protocol's WeakMap is keyed by. The adapter
 * attaches to the SAME instance, never a second server.
 */
const HOST_SERVERS = new WeakMap<SocketIoRailEmbeddedServer, SocketIoServer>();

/**
 * Boot the embedded socket.io rail server: a real node:http listener on
 * loopback with the published socket.io server attached (unmodified,
 * no fork, loaded lazily). The RAIL PROTOCOL itself (the grant
 * middleware + the channel registry + the rail handlers) is installed
 * by the adapter (see `createSocketIoRealtimeRail`) — the host is the
 * serving substrate.
 */
export async function bootEmbeddedSocketIoServer(
  options: {
    readonly bindHost?: string;
    /** 0 (the default) binds an ephemeral port. */
    readonly bindPort?: number;
    readonly railPath?: string;
  } = {},
): Promise<SocketIoRailEmbeddedServer> {
  const { createServer } = await import("node:http");
  const socketIoModule = await import("socket.io");
  const bindHost = options.bindHost ?? "127.0.0.1";
  const bindPort = options.bindPort ?? 0;
  const railPath = options.railPath ?? SOCKETIO_RAIL_PATH;

  const httpServer = createServer();
  const liveSockets = new Set<{ destroy(): void }>();
  httpServer.on("connection", (socket) => {
    liveSockets.add(socket);
    socket.on("close", () => liveSockets.delete(socket));
  });

  const server = new socketIoModule.Server(httpServer, {
    path: railPath,
    serveClient: false,
    pingInterval: 10_000,
    pingTimeout: 5_000,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(bindPort, bindHost, () => resolve());
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    throw new PlatformError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "the embedded realtime rail server could not bind its listen coordinate",
    });
  }
  function hostIsServing(): boolean {
    return httpServer.listening;
  }
  const host: SocketIoRailEmbeddedServer = {
    url: `http://${address.address}:${address.port}`,
    railPath,
    async stopServing() {
      if (!hostIsServing()) {
        return;
      }
      // Destroy live connections FIRST — close()'s callback otherwise
      // waits for them to end on their own (they never do).
      for (const socket of liveSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
    async startServing() {
      if (hostIsServing()) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(address.port, address.address, () => resolve());
      });
    },
    isServing: hostIsServing,
    observe() {
      return observeRailProtocol(server);
    },
    async close() {
      for (const socket of liveSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
  HOST_SERVERS.set(host, server);
  return host;
}

// ---------------------------------------------------------------------------
// The rail protocol (installed by the adapter on the embedded server).
// ---------------------------------------------------------------------------

/** One live channel in the server-side registry. */
interface RailChannelRecord {
  readonly applicationId: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly channelKind: string;
  readonly maxConcurrentSessions: number;
  readonly emptyTimeoutMs: number;
  readonly openedAt: string;
  lastEmptyAt: number | null;
}

/** One completed server-side effect (the upstream's own key semantics). */
interface RailEffectRecord {
  readonly deliveredAt: string;
  readonly railMetadata?: Readonly<Record<string, unknown>>;
}

/** The rail protocol state, keyed by the socket.io server instance. */
interface RailProtocolState {
  readonly channels: Map<string, RailChannelRecord>;
  readonly effects: Map<string, RailEffectRecord>;
  readonly counters: { open: number; deliver: number; transfer: number; close: number };
}

const RAIL_PROTOCOL_STATE = new WeakMap<SocketIoServer, RailProtocolState>();

/** The per-socket rail identity (set by the middleware; read by the handlers). */
interface SocketRailIdentity {
  readonly purpose: "join" | "dispatch";
  readonly room?: string;
}

const SOCKET_RAIL_IDENTITY = new WeakMap<SocketIoServerSocket, SocketRailIdentity>();

function freshProtocolState(): RailProtocolState {
  return {
    channels: new Map(),
    effects: new Map(),
    counters: { open: 0, deliver: 0, transfer: 0, close: 0 },
  };
}

function observeRailProtocol(server: SocketIoServer): SocketIoRailServerObservation {
  const state = RAIL_PROTOCOL_STATE.get(server);
  return {
    countChannelsCreated: () => state?.counters.open ?? 0,
    countDeliveriesCompleted: () => state?.counters.deliver ?? 0,
    countTransfersCompleted: () => state?.counters.transfer ?? 0,
    countClosesPerformed: () => state?.counters.close ?? 0,
    liveChannelCount: () => state?.channels.size ?? 0,
    connectedSocketCount: () => server.sockets.sockets.size,
  };
}

/** The neutral rail-protocol wire shapes (grant-authenticated, internal). */
interface RailOpenRequest {
  readonly applicationId: string;
  readonly roomName: string;
  readonly channelSessionRef: string;
  readonly channelKind: string;
  readonly sessionPolicy: {
    readonly maxSessionDurationMs: number;
    readonly maxConcurrentSessions: number;
  };
}

interface RailFrameEffectRequest {
  readonly applicationId: string;
  readonly roomName: string;
  readonly idempotencyKey: string;
  readonly ackTimeoutMs: number;
  readonly frame: {
    readonly kind: "deliver" | "transfer";
    readonly channelEpoch: number;
    readonly routeClass: string;
    readonly responseRef: string | null;
    readonly responsePreview: string;
    readonly cause: string | null;
  };
}

interface RailCloseRequest {
  readonly applicationId: string;
  readonly roomName: string;
  readonly idempotencyKey: string;
}

type RailProtocolAnswer =
  | {
      readonly ok: true;
      readonly converged?: boolean;
      readonly replayed?: boolean;
      readonly channelSessionRef?: string;
      readonly channelEpoch?: number;
      readonly deliveredAt: string;
      readonly railMetadata?: Readonly<Record<string, unknown>>;
    }
  | { readonly ok: false; readonly failure: SocketIoFailureKind };

/**
 * Install the rail protocol on one embedded socket.io server: the
 * grant-verifying handshake middleware (join grants are scoped,
 * single-purpose and channel-checked; dispatch grants carry the rail's
 * own authority), the channel registry, the empty-room sweep and the
 * dispatch-only rail event handlers. IDEMPOTENT per server instance —
 * the protocol (and its registry) SURVIVES fresh adapter instances
 * attaching to the same server (the crash model). The install is owned
 * by the FIRST adapter to bind the server; its grant verifier (and
 * therefore its credential source) governs every later attacher — the
 * composition binds exactly one credential set per server, and the
 * conformance crash model re-attaches with the same set.
 */
function installRailProtocol(
  server: SocketIoServer,
  options: {
    readonly verifyGrant: (grant: unknown) => GrantPayload | null;
    readonly now: () => Date;
  },
): RailProtocolState {
  const existing = RAIL_PROTOCOL_STATE.get(server);
  if (existing !== undefined) {
    return existing;
  }
  const state = freshProtocolState();
  RAIL_PROTOCOL_STATE.set(server, state);

  const sweep = setInterval(() => {
    const nowMs = options.now().getTime();
    for (const [roomName, record] of state.channels) {
      const sockets = server.sockets.adapter.rooms.get(roomName);
      if (sockets !== undefined && sockets.size > 0) {
        record.lastEmptyAt = null;
        continue;
      }
      if (record.lastEmptyAt === null) {
        record.lastEmptyAt = nowMs;
        continue;
      }
      if (nowMs - record.lastEmptyAt > record.emptyTimeoutMs) {
        // The bounded session policy's empty-room expiry (the honest
        // mapping of the policy's duration ceiling): the channel goes
        // away server-side, exactly like the reference rail's server.
        state.channels.delete(roomName);
      }
    }
  }, CHANNEL_SWEEP_INTERVAL_MS);
  sweep.unref();

  server.use((socket, next) => {
    const payload = options.verifyGrant((socket.handshake.auth as { grant?: unknown }).grant);
    if (payload === null) {
      next(new Error("the realtime rail refused the handshake grant"));
      return;
    }
    if (payload.e <= options.now().getTime()) {
      next(new Error("the realtime rail handshake grant has expired"));
      return;
    }
    if (payload.p === "dispatch") {
      SOCKET_RAIL_IDENTITY.set(socket, { purpose: "dispatch" });
      next();
      return;
    }
    const record = state.channels.get(payload.r ?? "");
    if (record === undefined) {
      next(new Error("the realtime rail channel is not open"));
      return;
    }
    const roomSockets = server.sockets.adapter.rooms.get(payload.r ?? "");
    if ((roomSockets?.size ?? 0) >= record.maxConcurrentSessions) {
      next(new Error("the realtime rail channel is at its session ceiling"));
      return;
    }
    SOCKET_RAIL_IDENTITY.set(socket, { purpose: "join", room: payload.r });
    next();
  });

  server.on("connection", (socket) => {
    const identity = SOCKET_RAIL_IDENTITY.get(socket);
    if (identity?.purpose !== "dispatch") {
      if (identity?.purpose === "join" && identity.room !== undefined) {
        socket.join(identity.room);
      }
      return;
    }
    // The dispatch authority: the rail's own event handlers. Every
    // handler answers through the ack callback — the upstream's real
    // answer, never fabricated.
    socket.on(
      "rail-open",
      (request: RailOpenRequest, ack: (answer: RailProtocolAnswer) => void) => {
        const existing = state.channels.get(request.roomName);
        if (existing !== undefined) {
          ack({
            ok: true,
            converged: true,
            channelSessionRef: existing.channelSessionRef,
            channelEpoch: existing.channelEpoch,
            deliveredAt: existing.openedAt,
          });
          return;
        }
        const record: RailChannelRecord = {
          applicationId: request.applicationId,
          channelSessionRef: request.channelSessionRef,
          channelEpoch: 1,
          channelKind: request.channelKind,
          maxConcurrentSessions: Math.max(request.sessionPolicy.maxConcurrentSessions, 1),
          emptyTimeoutMs: clampDurationSeconds(request.sessionPolicy.maxSessionDurationMs) * 1000,
          openedAt: options.now().toISOString(),
          lastEmptyAt: null,
        };
        state.channels.set(request.roomName, record);
        state.counters.open += 1;
        ack({
          ok: true,
          converged: false,
          channelSessionRef: record.channelSessionRef,
          channelEpoch: record.channelEpoch,
          deliveredAt: record.openedAt,
        });
      },
    );

    const handleFrameEffect = (
      kind: "deliver" | "transfer",
      request: RailFrameEffectRequest,
      ack: (answer: RailProtocolAnswer) => void,
    ): void => {
      const ledgerKey = `${kind}:${request.applicationId}:${request.idempotencyKey}`;
      const stored = state.effects.get(ledgerKey);
      if (stored !== undefined) {
        ack({
          ok: true,
          replayed: true,
          deliveredAt: stored.deliveredAt,
          ...(stored.railMetadata === undefined ? {} : { railMetadata: stored.railMetadata }),
        });
        return;
      }
      const record = state.channels.get(request.roomName);
      if (record === undefined) {
        ack({ ok: false, failure: "not-found" });
        return;
      }
      const event = kind === "deliver" ? "rail-turn" : "rail-transfer";
      server
        .to(request.roomName)
        .timeout(Math.max(request.ackTimeoutMs, 250))
        .emit(event, request.frame, (err: unknown) => {
          if (err !== null && err !== undefined) {
            // The bounded room-emit window expired without an
            // acknowledgment: the honest no-receiver condition.
            ack({ ok: false, failure: "no-receiver" });
            return;
          }
          const deliveredAt = options.now().toISOString();
          const railMetadata = { routeClass: request.frame.routeClass };
          state.effects.set(ledgerKey, { deliveredAt, railMetadata });
          if (kind === "deliver") {
            state.counters.deliver += 1;
          } else {
            state.counters.transfer += 1;
          }
          ack({ ok: true, replayed: false, deliveredAt, railMetadata });
        });
    };

    socket.on(
      "rail-deliver",
      (request: RailFrameEffectRequest, ack: (answer: RailProtocolAnswer) => void) => {
        handleFrameEffect("deliver", request, ack);
      },
    );

    socket.on(
      "rail-transfer",
      (request: RailFrameEffectRequest, ack: (answer: RailProtocolAnswer) => void) => {
        handleFrameEffect("transfer", request, ack);
      },
    );

    socket.on(
      "rail-close",
      (request: RailCloseRequest, ack: (answer: RailProtocolAnswer) => void) => {
        const ledgerKey = `close:${request.applicationId}:${request.idempotencyKey}`;
        const stored = state.effects.get(ledgerKey);
        if (stored !== undefined) {
          ack({ ok: true, replayed: true, deliveredAt: stored.deliveredAt });
          return;
        }
        const record = state.channels.get(request.roomName);
        const deliveredAt = options.now().toISOString();
        if (record === undefined) {
          // The upstream already holds the post-close state (a prior
          // close, or the empty-room expiry): the converged close,
          // never a fabricated fresh effect.
          state.effects.set(ledgerKey, { deliveredAt });
          ack({ ok: true, converged: true, deliveredAt });
          return;
        }
        server.in(request.roomName).disconnectSockets(true);
        state.channels.delete(request.roomName);
        state.counters.close += 1;
        state.effects.set(ledgerKey, { deliveredAt });
        ack({ ok: true, converged: false, deliveredAt });
      },
    );
  });

  return state;
}

// ---------------------------------------------------------------------------
// The short-lived client-access seam (PPR-010 requirement 2).
// ---------------------------------------------------------------------------

/** The neutral client-access request (no vendor shapes). */
export interface SocketIoRailClientAccessRequest {
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
 * The `grant` string is the opaque short-lived credential the receiver
 * redeems in the socket.io handshake auth payload — vendor material
 * by nature, confined to this field.
 */
export interface SocketIoRailClientAccess {
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
export interface SocketIoRailEffectRecord {
  readonly kind: SocketIoRailEffectKind;
  readonly applicationId: string;
  readonly sessionId: string | null;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly routeClass: string | null;
  readonly idempotencyKey: string;
  readonly cause: string | null;
  readonly at: string;
}

export interface SocketIoRealtimeRailOptions {
  /**
   * The LISTEN form: the adapter boots its own embedded server at this
   * coordinate (e.g. "http://127.0.0.1:37891", "ws://host:port" or
   * "host:port"; port 0 binds an ephemeral port).
   */
  readonly listenUrl: string;
  /**
   * The ATTACH form: bind an already-booted embedded server (the crash
   * model — a fresh adapter instance against the SURVIVING server and
   * its channel registry). Takes precedence over `listenUrl`.
   */
  readonly embeddedServer?: SocketIoRailEmbeddedServer;
  /** The composition-bound credential source (never plaintext). */
  readonly credentialSource: SocketIoRailCredentialSource;
  /** The neutral channel kinds this binding serves. */
  readonly channelKinds?: readonly string[];
  /** The adapter-side idempotency ledger (defaults to in-memory). */
  readonly ledger?: SocketIoRailIdempotencyLedger;
  /** The clock (tests); defaults to the system clock. */
  readonly now?: () => Date;
  /** The default client-access TTL (defaults to 600s). */
  readonly clientAccessDefaultTtlSeconds?: number;
  /** The bounded per-effect window in ms (dispatch + room acknowledgment). */
  readonly requestTimeoutMs?: number;
}

/** The socket.io realtime rail: the port plus the client-access seam. */
export interface SocketIoRealtimeRail {
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
  mintClientAccess(request: SocketIoRailClientAccessRequest): Promise<SocketIoRailClientAccess>;
  /**
   * The upstream side effects actually performed, in order (converged
   * replays record NOTHING here — exactly-once is the observable).
   */
  readonly upstreamEffects: readonly SocketIoRailEffectRecord[];
  /** The embedded server this rail listens on or attaches to (observability). */
  readonly embeddedServer: SocketIoRailEmbeddedServer | null;
  /** Shut the rail down (the dispatch connection; the listen-form server too). */
  close(): Promise<void>;
}

interface ChannelBinding {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly channelKind: string;
  readonly openIdempotencyKey: string;
  readonly roomName: string;
}

/**
 * Create the socket.io realtime rail. The vendor modules load LAZILY
 * on the first side effect, so an unbound composition never even
 * imports vendor code.
 */
export function createSocketIoRealtimeRail(
  options: SocketIoRealtimeRailOptions,
): SocketIoRealtimeRail {
  const channelKinds = options.channelKinds ?? SOCKETIO_RAIL_DEFAULT_CHANNEL_KINDS;
  const ledger = options.ledger ?? createInMemorySocketIoRailIdempotencyLedger();
  const now = options.now ?? (() => new Date());
  const requestTimeoutMs = options.requestTimeoutMs ?? SOCKETIO_RAIL_DEFAULT_REQUEST_TIMEOUT_MS;
  const effects: SocketIoRailEffectRecord[] = [];
  const channelBindings = new Map<string, ChannelBinding>();
  const closedChannelRefs = new Set<string>();
  let booted = false;
  let ownsServer = false;
  let host: SocketIoRailEmbeddedServer | null = null;
  let dispatchSocket: SocketIoClientSocket | null = null;
  let credential: MaterializedRailCredential | null = null;
  let lastConnectError: Error | null = null;

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

  async function boot(): Promise<void> {
    if (booted) {
      return;
    }
    // The credential is redeemed inside the adapter's own scope, for
    // the rail's first privileged act (the protocol install + the
    // dispatch authority), immediately before any upstream effect.
    const materialized = await materializeCredential({
      applicationId: "rail-boot",
      tenantId: "rail-boot",
      channelKind: "web",
      attemptId: "rail-boot",
    });
    if (options.embeddedServer !== undefined) {
      host = options.embeddedServer;
      ownsServer = false;
    } else {
      host = await bootEmbeddedSocketIoServer(parseListenCoordinate(options.listenUrl));
      ownsServer = true;
    }
    const ioServer = HOST_SERVERS.get(host);
    if (ioServer === undefined) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "the embedded realtime rail server lost its vendor instance",
        retryable: false,
      });
    }
    installRailProtocol(ioServer, {
      verifyGrant: (grant) => verifyGrant(materialized.authSecret, grant),
      now,
    });
    const socketIoClientModule = await import("socket.io-client");
    const client = socketIoClientModule.io(host.url, {
      path: host.railPath,
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 100,
      reconnectionDelayMax: 400,
      randomizationFactor: 0,
      timeout: Math.min(requestTimeoutMs, 2_000),
      // A FRESH dispatch grant on every (re)connection attempt — the
      // grant's TTL never outlives the rail's authority.
      auth: (cb: (payload: { grant: string }) => void) => {
        const expiresAt = now().getTime() + DISPATCH_GRANT_TTL_SECONDS * 1000;
        const payloadHex = encodeGrantPayload({ p: "dispatch", e: expiresAt });
        cb({ grant: `zeckgrant1.${payloadHex}.${signGrant(materialized.authSecret, payloadHex)}` });
      },
    });
    client.on("connect", () => {
      lastConnectError = null;
    });
    client.on("connect_error", (error: Error) => {
      lastConnectError = error;
    });
    dispatchSocket = client;
    booted = true;
  }

  async function dispatch(): Promise<SocketIoClientSocket> {
    await boot();
    const socket = dispatchSocket;
    if (socket === null) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "realtime rail upstream unreachable",
        retryable: true,
      });
    }
    if (!socket.connected) {
      // The honest transient window: the dispatch connection is down
      // (the embedded server's real "went away" mode) — wait for the
      // bounded reconnection window, then fail neutrally.
      const connected = await new Promise<boolean>((resolve) => {
        const onConnect = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          socket.off("connect", onConnect);
          resolve(false);
        }, requestTimeoutMs);
        socket.once("connect", onConnect);
      });
      if (!connected) {
        const classification = classifySocketIoFailure(
          lastConnectError ?? new Error("the dispatch connection timed out"),
        );
        throw new PlatformError({
          code: classification.code,
          message: classification.reason,
          retryable: classification.retryable,
          ...(lastConnectError === null ? {} : { cause: lastConnectError }),
        });
      }
    }
    return socket;
  }

  function emitWithAck<Answer extends RailProtocolAnswer>(
    socket: SocketIoClientSocket,
    event: string,
    payload: unknown,
  ): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      socket.timeout(requestTimeoutMs).emit(event, payload, (err: unknown, answer?: Answer) => {
        if (err !== null && err !== undefined) {
          reject(classifySocketIoFailure(err instanceof Error ? err : new Error(String(err))));
          return;
        }
        if (answer === undefined) {
          reject(classifySocketIoFailure(new Error("the realtime rail upstream did not answer")));
          return;
        }
        resolve(answer);
      });
    });
  }

  function record(effect: Omit<SocketIoRailEffectRecord, "at">): void {
    effects.push({ ...effect, at: now().toISOString() });
  }

  function throwOpenFailure(error: unknown): never {
    if (error instanceof PlatformError) {
      throw error;
    }
    const classification = classifySocketIoFailure(error);
    throw new PlatformError({
      code: classification.code,
      message: classification.reason,
      retryable: classification.retryable,
      cause: error,
    });
  }

  function outcomeFailure(error: unknown): RealtimeRailDeliveryOutcome {
    if (error instanceof PlatformError) {
      // Already normalized (the dispatch path's bounded-wait throw
      // carries the neutral reason verbatim from the same table);
      // re-classifying the WRAPPED message would wrongly collapse it
      // into upstream-error ("unreachable" matches no vendor pattern).
      return { delivered: false, reason: error.message };
    }
    const classification = classifySocketIoFailure(error);
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
    const binding = channelBindings.get(frame.channelSessionRef);
    const roomName =
      binding !== undefined && binding.applicationId === frame.applicationId
        ? binding.roomName
        : socketIoUpstreamChannelNameOf(frame.applicationId, `ref:${frame.channelSessionRef}`);
    try {
      const socket = await dispatch();
      const answer = await emitWithAck<RailProtocolAnswer>(
        socket,
        kind === "deliver" ? "rail-deliver" : "rail-transfer",
        {
          applicationId: frame.applicationId,
          roomName,
          idempotencyKey: frame.idempotencyKey,
          ackTimeoutMs: Math.max(requestTimeoutMs - 250, 250),
          frame: {
            kind,
            channelEpoch: frame.channelEpoch,
            routeClass: frame.routeClass,
            responseRef: frame.responseRef,
            responsePreview: frame.responsePreview.slice(0, MAX_UPSTREAM_PREVIEW_CHARS),
            cause: frame.cause,
          },
        },
      );
      if (!answer.ok) {
        return { delivered: false, reason: SOCKETIO_FAILURE_NORMALIZATION[answer.failure].reason };
      }
      const deliveredAt = answer.deliveredAt;
      const railMetadata = answer.railMetadata ?? { routeClass: frame.routeClass };
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
      railCapabilityId: SOCKETIO_RAIL_CAPABILITY_ID,
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
      const roomName = socketIoUpstreamChannelNameOf(request.applicationId, request.idempotencyKey);
      const channelSessionRef =
        request.channelSessionRef ??
        socketIoChannelSessionRefOf(
          request.applicationId,
          request.idempotencyKey,
          request.channelKind,
        );
      try {
        // Convergence check through the server's own registry: an
        // upstream channel under this exact name is the durable record
        // of a prior open (a crash replay) — converge on it, never
        // create a second one.
        const socket = await dispatch();
        const answer = await emitWithAck<RailProtocolAnswer>(socket, "rail-open", {
          applicationId: request.applicationId,
          roomName,
          channelSessionRef,
          channelKind: request.channelKind,
          sessionPolicy: { ...request.sessionPolicy },
        });
        if (!answer.ok) {
          throwOpenFailure({ failure: answer.failure });
        }
        const converged = answer.converged === true;
        const session: RealtimeRailSession = {
          channelSessionRef: answer.channelSessionRef ?? channelSessionRef,
          channelEpoch: answer.channelEpoch ?? 1,
          railMetadata: {
            channelKind: request.channelKind,
            sessionPolicy: { ...request.sessionPolicy },
          },
          replayed: converged,
        };
        await ledger.remember("open", request.applicationId, request.idempotencyKey, {
          channelSessionRef: session.channelSessionRef,
          channelEpoch: session.channelEpoch,
          railMetadata: session.railMetadata,
          deliveredAt: now().toISOString(),
        });
        channelBindings.set(session.channelSessionRef, {
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
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
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
          : socketIoUpstreamChannelNameOf(
              reference.applicationId,
              `ref:${reference.channelSessionRef}`,
            );
      try {
        const socket = await dispatch();
        const answer = await emitWithAck<RailProtocolAnswer>(socket, "rail-close", {
          applicationId: reference.applicationId,
          roomName,
          idempotencyKey: reference.idempotencyKey,
        });
        if (!answer.ok) {
          return {
            delivered: false,
            reason: SOCKETIO_FAILURE_NORMALIZATION[answer.failure].reason,
          };
        }
        const converged = answer.converged === true;
        const deliveredAt = answer.deliveredAt;
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
      const ttlSeconds = socketIoClientAccessTtlOf(
        request.sessionPolicy.maxSessionDurationMs,
        options.clientAccessDefaultTtlSeconds ?? SOCKETIO_CLIENT_ACCESS_DEFAULT_TTL_SECONDS,
      );
      const materialized = await materializeCredential({
        applicationId: request.applicationId,
        tenantId: binding.tenantId,
        channelKind: binding.channelKind,
        attemptId: `client-access:${request.channelSessionRef}`,
      });
      const expiresAtMs = now().getTime() + ttlSeconds * 1000;
      // SINGLE-PURPOSE (join, not administer): scoped to the one
      // channel, honored only while that channel is open.
      const payloadHex = encodeGrantPayload({
        p: "join",
        r: binding.roomName,
        c: request.channelSessionRef,
        e: expiresAtMs,
      });
      const grant = `zeckgrant1.${payloadHex}.${signGrant(materialized.authSecret, payloadHex)}`;
      return {
        channelSessionRef: request.channelSessionRef,
        channelEpoch: request.channelEpoch,
        purpose: "join",
        ttlSeconds,
        expiresAt: new Date(expiresAtMs).toISOString(),
        grant,
      };
    },

    get upstreamEffects() {
      return effects;
    },

    get embeddedServer() {
      return host;
    },

    async close() {
      dispatchSocket?.close();
      dispatchSocket = null;
      if (ownsServer) {
        await host?.close();
      }
      host = null;
      booted = false;
    },
  };
}

function parseListenCoordinate(listenUrl: string): { bindHost: string; bindPort: number } {
  const trimmed = listenUrl.trim();
  const coordinate = /^https?:\/\//.test(trimmed)
    ? new URL(trimmed)
    : /^wss?:\/\//.test(trimmed)
      ? new URL(`http://${trimmed.slice(trimmed.indexOf("//") + 2)}`)
      : new URL(`http://${trimmed}`);
  const port = Number(coordinate.port || 80);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new PlatformError({
      code: "CAPABILITY_UNAVAILABLE",
      message: "the realtime rail listen coordinate is not a bindable host:port",
    });
  }
  return { bindHost: coordinate.hostname || "127.0.0.1", bindPort: port };
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
  const record = parsed as { authSecret?: unknown };
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.authSecret !== "string" ||
    record.authSecret.length === 0
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "the realtime rail credential envelope is missing its auth secret member",
      retryable: false,
    });
  }
  return { authSecret: record.authSecret };
}
