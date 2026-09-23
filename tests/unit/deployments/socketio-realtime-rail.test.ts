/**
 * socket.io realtime rail adapter unit proofs (PPR-010 verification).
 *
 * Server-FREE unit proofs for the surfaces that must hold without a
 * running upstream session lifecycle (the embedded server itself boots
 * only where a proof needs it): the neutral-shape guarantee (vendor
 * confinement for BOTH vendor packages), the opaque-ref derivation,
 * the client-access TTL bounds, the failure normalization table, the
 * credential-envelope discipline, the idempotency ledger, the listen
 * coordinate validation, the environment composition gate (pinned
 * both ways), and the unreachable-upstream normalization through the
 * full adapter path (the embedded server's real "went away" mode).
 * The REAL-server proofs (lifecycle, key convergence, crash replay,
 * the minted grant's real join) live in
 * tests/conformance/realtime-rail/socketio-rail.conformance.test.ts.
 *
 * No credential VALUES are committed: every fixture below is the
 * repository's synthetic style.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifySocketIoFailure,
  createEnvironmentSocketIoCredentialSource,
  createInMemorySocketIoRailIdempotencyLedger,
  createSocketIoRealtimeRail,
  LOCAL_SOCKETIO_SERVER_LABEL,
  SOCKETIO_CLIENT_ACCESS_DEFAULT_TTL_SECONDS,
  SOCKETIO_CLIENT_ACCESS_HARD_CEILING_SECONDS,
  SOCKETIO_FAILURE_NORMALIZATION,
  SOCKETIO_RAIL_CAPABILITY_ID,
  SOCKETIO_RAIL_DEFAULT_CHANNEL_KINDS,
  socketIoChannelSessionRefOf,
  socketIoClientAccessTtlOf,
  socketIoUpstreamChannelNameOf,
} from "../../../src/modules/deployments/adapters/socketio-realtime-rail";
import {
  bindEnvironmentSocketIoRail,
  readSocketIoRailMaterialization,
  SOCKETIO_RAIL_ENV_VARIABLES,
} from "../../../src/modules/deployments/adapters/socketio-realtime-rail-binding";
import type { RealtimeRailSessionRequest } from "../../../src/modules/deployments/ports/realtime-rail";
import { PlatformError } from "../../../src/shared/errors";

const ADAPTER_PATH = join(
  process.cwd(),
  "src/modules/deployments/adapters/socketio-realtime-rail.ts",
);

const SYNTHETIC_AUTH_SECRET = "sk-socketio-synthetic-unit-secret";

function syntheticCredentialSource() {
  return createEnvironmentSocketIoCredentialSource({
    reference: "unit-synthetic-socketio-credential",
    connectionId: "unit-socketio",
    authSecret: SYNTHETIC_AUTH_SECRET,
  });
}

function openRequest(idempotencyKey: string): RealtimeRailSessionRequest {
  return {
    applicationId: "00000000-0000-7000-8000-000000000081",
    tenantId: "00000000-0000-7000-8000-000000000082",
    deploymentId: "00000000-0000-7000-8000-000000000083",
    pinnedPlanId: "00000000-0000-7000-8000-000000000084",
    pinnedPlanVersion: 1,
    executionId: "00000000-0000-7000-8000-000000000085",
    channelKind: "web",
    idempotencyKey,
    channelSessionRef: null,
    callerRef: null,
    sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
  };
}

describe("socketio realtime rail — vendor confinement (the neutral-shape guarantee)", () => {
  test("the adapter file never runtime-imports or re-exports the vendor packages", () => {
    const source = readFileSync(ADAPTER_PATH, "utf8");
    const runtimeImports = source.match(/^import\s(?!type)[^"]*"socket\.io(-client)?"/gm) ?? [];
    expect(
      runtimeImports,
      "the vendor packages are imported TYPE-ONLY at module scope",
    ).toHaveLength(0);
    const reExports = source.match(/^export\s[^;]*from\s*"socket\.io(-client)?"/gm) ?? [];
    expect(reExports, "nothing from the vendor packages is re-exported").toHaveLength(0);
    const dynamicServer = source.match(/await import\("socket\.io"\)/g) ?? [];
    expect(dynamicServer.length, "the server package loads lazily on the first side effect").toBe(
      1,
    );
    const dynamicClient = source.match(/await import\("socket\.io-client"\)/g) ?? [];
    expect(dynamicClient.length, "the dispatch client loads lazily too").toBe(1);
  });

  test("the module's exported surface is vendor-free (no SDK type leaks)", async () => {
    const moduleNamespace = await import(
      "../../../src/modules/deployments/adapters/socketio-realtime-rail"
    );
    const exported = Object.keys(moduleNamespace).sort();
    for (const name of exported) {
      expect(name, `exported symbol "${name}" must not be a vendor SDK shape`).not.toMatch(
        /^(Server|Socket| io |io$|Engine|Namespace|Broadcast|EIO|Manager)/,
      );
    }
    expect(exported).toContain("createSocketIoRealtimeRail");
    expect(exported).toContain("classifySocketIoFailure");
    expect(exported).toContain("bootEmbeddedSocketIoServer");
  });

  test("the binding module's exported surface is vendor-free too", async () => {
    const moduleNamespace = await import(
      "../../../src/modules/deployments/adapters/socketio-realtime-rail-binding"
    );
    for (const name of Object.keys(moduleNamespace)) {
      expect(name).not.toMatch(/^(Server|Socket|Engine|Namespace|Broadcast|EIO|Manager)/);
    }
  });
});

describe("socketio realtime rail — opaque, non-PII coordinate derivation", () => {
  test("the upstream channel name is deterministic, opaque and hash-bounded", () => {
    const a = socketIoUpstreamChannelNameOf("app-1", "rtrail:open:key-1");
    const b = socketIoUpstreamChannelNameOf("app-1", "rtrail:open:key-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^zecksio-[0-9a-f]{24}$/);
    expect(a).not.toContain("app-1");
    expect(a).not.toContain("key-1");
    const other = socketIoUpstreamChannelNameOf("app-1", "rtrail:open:key-2");
    expect(other).not.toBe(a);
  });

  test("the channel-session ref is deterministic, opaque and in a distinct hash domain", () => {
    const ref = socketIoChannelSessionRefOf("app-1", "rtrail:open:key-1", "web");
    expect(ref).toBe(socketIoChannelSessionRefOf("app-1", "rtrail:open:key-1", "web"));
    expect(ref).toMatch(/^siort-[0-9a-f]{24}$/);
    expect(ref).not.toBe(socketIoUpstreamChannelNameOf("app-1", "rtrail:open:key-1"));
    expect(socketIoChannelSessionRefOf("app-1", "rtrail:open:key-1", "telephony")).not.toBe(ref);
  });

  test("user-provided strings never enter the derivations verbatim", () => {
    const callerMarker = "caller-pii-marker";
    const name = socketIoUpstreamChannelNameOf("app-1", `rtrail:open:${callerMarker}`);
    const ref = socketIoChannelSessionRefOf("app-1", `rtrail:open:${callerMarker}`, "web");
    expect(`${name}${ref}`).not.toContain(callerMarker);
  });

  test("the honest local-proof label is the neutral self-designation", () => {
    expect(LOCAL_SOCKETIO_SERVER_LABEL).toBe("local-socketio-server");
  });
});

describe("socketio realtime rail — the short-lived client-access TTL bounds", () => {
  test("the TTL defaults minutes, never hours", () => {
    expect(SOCKETIO_CLIENT_ACCESS_DEFAULT_TTL_SECONDS).toBe(600);
    expect(SOCKETIO_CLIENT_ACCESS_DEFAULT_TTL_SECONDS).toBeLessThan(3600);
  });

  test("the TTL respects the session policy ceiling", () => {
    expect(socketIoClientAccessTtlOf(30_000, 600)).toBe(30);
  });

  test("the TTL respects the hard ceiling above any policy", () => {
    expect(socketIoClientAccessTtlOf(3_600_000_000, 7_200)).toBe(
      SOCKETIO_CLIENT_ACCESS_HARD_CEILING_SECONDS,
    );
    expect(SOCKETIO_CLIENT_ACCESS_HARD_CEILING_SECONDS).toBe(3600);
  });

  test("the TTL never drops below one second", () => {
    expect(socketIoClientAccessTtlOf(0, 600)).toBe(1);
  });
});

describe("socketio realtime rail — the failure normalization table", () => {
  test("the table covers exactly the six neutral kinds (five shared + no-receiver)", () => {
    expect(Object.keys(SOCKETIO_FAILURE_NORMALIZATION).sort()).toEqual([
      "authentication",
      "no-receiver",
      "not-found",
      "quota",
      "unreachable",
      "upstream-error",
    ]);
  });

  test("the entire reason vocabulary is vendor-free", () => {
    for (const entry of Object.values(SOCKETIO_FAILURE_NORMALIZATION)) {
      expect(entry.reason).not.toMatch(
        /socket\.?io|engine\.?io|livekit|twirp|grpc|webrtc|econnrefused|etimedout|handshake/i,
      );
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  test("the five shared kinds carry the LiveKit table's EXACT reasons (the substitution invariant)", async () => {
    // The drill's shared-vocabulary guarantee, pinned at the unit level
    // too: a refusal means the same thing on every rail.
    const { LIVEKIT_FAILURE_NORMALIZATION } = await import(
      "../../../src/modules/deployments/adapters/livekit-realtime-rail"
    );
    for (const kind of [
      "unreachable",
      "authentication",
      "not-found",
      "quota",
      "upstream-error",
    ] as const) {
      expect(SOCKETIO_FAILURE_NORMALIZATION[kind].reason).toBe(
        LIVEKIT_FAILURE_NORMALIZATION[kind].reason,
      );
      expect(SOCKETIO_FAILURE_NORMALIZATION[kind].code).toBe(
        LIVEKIT_FAILURE_NORMALIZATION[kind].code,
      );
    }
  });

  test("auth failures are terminal; capacity, reachability and no-receiver are retryable", () => {
    expect(SOCKETIO_FAILURE_NORMALIZATION.authentication.retryable).toBe(false);
    expect(SOCKETIO_FAILURE_NORMALIZATION["not-found"].retryable).toBe(false);
    expect(SOCKETIO_FAILURE_NORMALIZATION["upstream-error"].retryable).toBe(false);
    expect(SOCKETIO_FAILURE_NORMALIZATION.unreachable.retryable).toBe(true);
    expect(SOCKETIO_FAILURE_NORMALIZATION.quota.retryable).toBe(true);
    expect(SOCKETIO_FAILURE_NORMALIZATION["no-receiver"].retryable).toBe(true);
  });

  test("structured rail-protocol failures map directly by kind", () => {
    expect(classifySocketIoFailure({ failure: "no-receiver" }).kind).toBe("no-receiver");
    expect(classifySocketIoFailure({ failure: "quota" }).kind).toBe("quota");
  });

  test("transport-level failures classify as unreachable", () => {
    expect(classifySocketIoFailure(new Error("connect ECONNREFUSED 127.0.0.1:37891")).kind).toBe(
      "unreachable",
    );
    expect(classifySocketIoFailure(new Error("websocket connection timed out")).kind).toBe(
      "unreachable",
    );
  });

  test("handshake/credential failures classify as authentication", () => {
    expect(classifySocketIoFailure(new Error("the handshake grant was rejected")).kind).toBe(
      "authentication",
    );
  });

  test("unknown vendor failures collapse to the neutral upstream-error", () => {
    expect(classifySocketIoFailure(new Error("some vendor nonsense")).kind).toBe("upstream-error");
  });
});

describe("socketio realtime rail — the credential-envelope discipline", () => {
  test("the environment source resolves a fixed reference and redeems its envelope", async () => {
    const source = syntheticCredentialSource();
    const resolved = await source.resolve({
      applicationId: "app",
      tenantId: "tenant",
      channelKind: "web",
    });
    expect(resolved).not.toBeNull();
    if (resolved !== null) {
      const materialized = await source.materialize(resolved.credentialRef, {
        attemptId: "unit",
        connectionId: resolved.connectionId,
      });
      expect(materialized.plaintext).toContain("authSecret");
      expect(materialized.plaintext).toContain(SYNTHETIC_AUTH_SECRET);
    }
  });

  test("the environment source refuses an unknown reference (fail closed)", async () => {
    const source = syntheticCredentialSource();
    await expect(
      source.materialize("zeck-secret://local/some-other-reference", {
        attemptId: "unit",
        connectionId: "unit-socketio",
      }),
    ).rejects.toBeInstanceOf(PlatformError);
  });
});

describe("socketio realtime rail — the in-memory idempotency ledger", () => {
  test("remember/lookup round-trips per (kind, application, key)", async () => {
    const ledger = createInMemorySocketIoRailIdempotencyLedger();
    await ledger.remember("deliver", "app-1", "rtrail:deliver:key-1", {
      deliveredAt: "2026-09-23T00:00:00.000Z",
      railMetadata: { routeClass: "generative" },
    });
    const stored = await ledger.lookup("deliver", "app-1", "rtrail:deliver:key-1");
    expect(stored).not.toBeNull();
    expect(stored?.deliveredAt).toBe("2026-09-23T00:00:00.000Z");
    expect(await ledger.lookup("deliver", "app-1", "rtrail:deliver:key-2")).toBeNull();
    expect(await ledger.lookup("transfer", "app-1", "rtrail:deliver:key-1")).toBeNull();
    expect(await ledger.lookup("deliver", "app-2", "rtrail:deliver:key-1")).toBeNull();
  });
});

describe("socketio realtime rail — the environment composition gate (pinned both ways)", () => {
  test("a materialized credential set binds the REAL alternate rail", () => {
    const binding = bindEnvironmentSocketIoRail({
      [SOCKETIO_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:37891",
      [SOCKETIO_RAIL_ENV_VARIABLES.authSecret]: SYNTHETIC_AUTH_SECRET,
    });
    expect(binding.binding).toBe("socketio");
    expect(binding.isRealRail).toBe(true);
    expect(binding.socketIoUrl).toBe("http://127.0.0.1:37891");
    expect(binding.missing).toEqual([]);
    expect(binding.rail.descriptor.railCapabilityId).toBe(SOCKETIO_RAIL_CAPABILITY_ID);
    expect(binding.rail.descriptor.channelKinds).toEqual(SOCKETIO_RAIL_DEFAULT_CHANNEL_KINDS);
  });

  test("any missing piece keeps EXACTLY today's simulated shape", () => {
    const partial = bindEnvironmentSocketIoRail({
      [SOCKETIO_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:37891",
    });
    expect(partial.binding).toBe("simulated");
    expect(partial.isRealRail).toBe(false);
    expect(partial.socketIoUrl).toBeNull();
    expect(partial.missing).toEqual([SOCKETIO_RAIL_ENV_VARIABLES.authSecret]);
    expect(partial.rail.descriptor.railCapabilityId).toBe("simulated-realtime-rail");

    const empty = bindEnvironmentSocketIoRail({});
    expect(empty.binding).toBe("simulated");
    expect(empty.missing).toEqual([
      SOCKETIO_RAIL_ENV_VARIABLES.url,
      SOCKETIO_RAIL_ENV_VARIABLES.authSecret,
    ]);
    expect(empty.rail.descriptor.transportClass).toBe("realtime");
  });

  test("the gate never echoes credential values (secret hygiene)", () => {
    const binding = bindEnvironmentSocketIoRail({
      [SOCKETIO_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:37891",
      [SOCKETIO_RAIL_ENV_VARIABLES.authSecret]: SYNTHETIC_AUTH_SECRET,
    });
    const serialized = JSON.stringify(binding);
    expect(serialized).not.toContain(SYNTHETIC_AUTH_SECRET);
    const materialization = readSocketIoRailMaterialization({
      [SOCKETIO_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:37891",
      [SOCKETIO_RAIL_ENV_VARIABLES.authSecret]: SYNTHETIC_AUTH_SECRET,
    });
    expect(JSON.stringify(materialization)).not.toContain(SYNTHETIC_AUTH_SECRET);
  });

  test("the gate's env names follow the established grammar", () => {
    expect(SOCKETIO_RAIL_ENV_VARIABLES.url).toBe("ZECK_SOCKETIO_URL");
    expect(SOCKETIO_RAIL_ENV_VARIABLES.authSecret).toBe("ZECK_SOCKETIO_AUTH_SECRET");
  });
});

describe("socketio realtime rail — the unreachable upstream (full-path normalization)", () => {
  test("openSession against a stopped listener rejects with the neutral unreachable shape", async () => {
    const rail = createSocketIoRealtimeRail({
      listenUrl: "http://127.0.0.1:0",
      credentialSource: syntheticCredentialSource(),
      requestTimeoutMs: 800,
    });
    // Boot against the healthy ephemeral listener, then STOP it — the
    // embedded server's own real "went away" mode. The settle lets the
    // dispatch connection REGISTER the loss first (the reconnect loop's
    // own transport error is then the classification basis — the
    // bounded-wait path, not the in-flight-emit path).
    await rail.openSession(openRequest("rtrail:open:unit-stop-1"));
    const host = rail.embeddedServer;
    expect(host).not.toBeNull();
    await host?.stopServing();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const failure = await rail.openSession(openRequest("rtrail:open:unit-stopped-1")).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PlatformError);
    const platformError = failure as PlatformError;
    expect(platformError.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(platformError.retryable).toBe(true);
    expect(platformError.message).toBe("realtime rail upstream unreachable");
    await host?.startServing();
    await rail.close();
  });

  test("deliverTurn against a stopped listener normalizes into the failure outcome", async () => {
    const rail = createSocketIoRealtimeRail({
      listenUrl: "http://127.0.0.1:0",
      credentialSource: syntheticCredentialSource(),
      requestTimeoutMs: 800,
    });
    const session = await rail.openSession(openRequest("rtrail:open:unit-stop-2"));
    const host = rail.embeddedServer;
    await host?.stopServing();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const outcome = await rail.deliverTurn({
      applicationId: "00000000-0000-7000-8000-000000000081",
      sessionId: "session-unit-2",
      channelSessionRef: session.channelSessionRef,
      channelEpoch: session.channelEpoch,
      routeClass: "generative",
      idempotencyKey: "rtrail:deliver:unit-stopped-2",
      responseRef: "artifact://realtime/turns/unit-2",
      responsePreview: "bounded unit preview",
      cause: null,
    });
    expect(outcome.delivered).toBe(false);
    if (!outcome.delivered) {
      expect(outcome.reason).toBe("realtime rail upstream unreachable");
    }
    // The refusal is NEVER cached under the key: after the recovery the
    // same key delivers (exactly one upstream effect — C9's discipline).
    await host?.startServing();
    const dispatchBack = await (async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((host?.observe().connectedSocketCount() ?? 0) >= 1) {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    })();
    expect(dispatchBack).toBe(true);
    const retried = await rail.deliverTurn({
      applicationId: "00000000-0000-7000-8000-000000000081",
      sessionId: "session-unit-2",
      channelSessionRef: session.channelSessionRef,
      channelEpoch: session.channelEpoch,
      routeClass: "generative",
      idempotencyKey: "rtrail:deliver:unit-stopped-2",
      responseRef: "artifact://realtime/turns/unit-2",
      responsePreview: "bounded unit preview",
      cause: null,
    });
    expect(retried.delivered).toBe(true);
    if (retried.delivered) {
      expect(retried.replayed).toBe(false);
    }
    await rail.close();
  });
});
