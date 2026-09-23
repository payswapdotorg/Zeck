/**
 * LiveKit realtime rail adapter unit proofs (PPR-009 verification).
 *
 * Server-FREE unit proofs for the surfaces that must hold without any
 * upstream: the neutral-shape guarantee (vendor confinement), the
 * opaque-ref derivation, the client-access TTL bounds, the failure
 * normalization table, the credential-envelope discipline, the
 * idempotency ledger, the environment composition gate (pinned both
 * ways), and the unreachable-upstream normalization through the full
 * adapter path. The REAL-server proofs (lifecycle, key convergence,
 * crash replay, the minted grant's single-purpose decode) live in
 * tests/conformance/realtime-rail/livekit-rail.conformance.test.ts.
 *
 * No credential VALUES are committed: every fixture below is the
 * repository's synthetic style.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PlatformError } from "../../../src/shared/errors";
import {
  bindEnvironmentRealtimeRail,
  readLiveKitRailMaterialization,
  LIVEKIT_RAIL_ENV_VARIABLES,
} from "../../../src/modules/deployments/adapters/livekit-realtime-rail-binding";
import {
  classifyLiveKitFailure,
  clientAccessTtlOf,
  CLIENT_ACCESS_DEFAULT_TTL_SECONDS,
  CLIENT_ACCESS_HARD_CEILING_SECONDS,
  createEnvironmentLiveKitCredentialSource,
  createInMemoryLiveKitRailIdempotencyLedger,
  createLiveKitRealtimeRail,
  LIVEKIT_FAILURE_NORMALIZATION,
  LIVEKIT_RAIL_CAPABILITY_ID,
  LIVEKIT_RAIL_DEFAULT_CHANNEL_KINDS,
  liveKitChannelSessionRefOf,
  liveKitUpstreamChannelNameOf,
} from "../../../src/modules/deployments/adapters/livekit-realtime-rail";
import type { RealtimeRailSessionRequest } from "../../../src/modules/deployments/ports/realtime-rail";

const ADAPTER_PATH = join(
  process.cwd(),
  "src/modules/deployments/adapters/livekit-realtime-rail.ts",
);

const SYNTHETIC_API_KEY = "sk-livekit-synthetic-unit-key";
const SYNTHETIC_API_SECRET = "sk-livekit-synthetic-unit-secret";

function syntheticCredentialSource() {
  return createEnvironmentLiveKitCredentialSource({
    reference: "unit-synthetic-livekit-credential",
    connectionId: "unit-livekit",
    apiKey: SYNTHETIC_API_KEY,
    apiSecret: SYNTHETIC_API_SECRET,
  });
}

function openRequest(idempotencyKey: string): RealtimeRailSessionRequest {
  return {
    applicationId: "00000000-0000-7000-8000-000000000021",
    tenantId: "00000000-0000-7000-8000-000000000022",
    deploymentId: "00000000-0000-7000-8000-000000000023",
    pinnedPlanId: "00000000-0000-7000-8000-000000000024",
    pinnedPlanVersion: 1,
    executionId: "00000000-0000-7000-8000-000000000025",
    channelKind: "web",
    idempotencyKey,
    channelSessionRef: null,
    callerRef: "unit-caller-ref",
    sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 4 },
  };
}

describe("livekit realtime rail — vendor confinement (the neutral-shape guarantee)", () => {
  test("the adapter file never runtime-imports or re-exports the vendor SDK", () => {
    const source = readFileSync(ADAPTER_PATH, "utf8");
    const runtimeImports = source.match(/^import\s(?!type)[^"]*"livekit-server-sdk"/gm) ?? [];
    expect(runtimeImports, "the SDK is imported TYPE-ONLY at module scope").toHaveLength(0);
    const reExports = source.match(/^export\s[^;]*from\s*"livekit-server-sdk"/gm) ?? [];
    expect(reExports, "nothing from the vendor SDK is re-exported").toHaveLength(0);
    const dynamicImports = source.match(/await import\("livekit-server-sdk"\)/g) ?? [];
    expect(dynamicImports.length, "the SDK loads lazily on the first side effect").toBe(1);
  });

  test("the module's exported surface is vendor-free (no SDK type leaks)", async () => {
    const moduleNamespace = await import(
      "../../../src/modules/deployments/adapters/livekit-realtime-rail"
    );
    const exported = Object.keys(moduleNamespace).sort();
    for (const name of exported) {
      expect(name, `exported symbol "${name}" must not be a vendor SDK shape`).not.toMatch(
        /^(Room|AccessToken|VideoGrant|DataPacket|Webhook|Egress|Ingress|SIP|Twirp|AgentDispatch)/,
      );
    }
    expect(exported).toContain("createLiveKitRealtimeRail");
    expect(exported).toContain("classifyLiveKitFailure");
  });

  test("the binding module's exported surface is vendor-free too", async () => {
    const moduleNamespace = await import(
      "../../../src/modules/deployments/adapters/livekit-realtime-rail-binding"
    );
    for (const name of Object.keys(moduleNamespace)) {
      expect(name).not.toMatch(/^(Room|AccessToken|VideoGrant|DataPacket|Webhook|Twirp)/);
    }
  });
});

describe("livekit realtime rail — opaque, non-PII coordinate derivation", () => {
  test("the upstream channel name is deterministic, opaque and hash-bounded", () => {
    const a = liveKitUpstreamChannelNameOf("app-1", "rtrail:open:key-1");
    const b = liveKitUpstreamChannelNameOf("app-1", "rtrail:open:key-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^zeckrt-[0-9a-f]{24}$/);
    expect(a).not.toContain("app-1");
    expect(a).not.toContain("key-1");
    const other = liveKitUpstreamChannelNameOf("app-1", "rtrail:open:key-2");
    expect(other).not.toBe(a);
  });

  test("the channel-session ref is deterministic, opaque and in a distinct hash domain", () => {
    const ref = liveKitChannelSessionRefOf("app-1", "rtrail:open:key-1", "web");
    expect(ref).toBe(liveKitChannelSessionRefOf("app-1", "rtrail:open:key-1", "web"));
    expect(ref).toMatch(/^rtch-[0-9a-f]{24}$/);
    expect(ref).not.toBe(liveKitUpstreamChannelNameOf("app-1", "rtrail:open:key-1"));
    expect(liveKitChannelSessionRefOf("app-1", "rtrail:open:key-1", "telephony")).not.toBe(ref);
  });

  test("user-provided strings never enter the derivations verbatim", () => {
    const callerMarker = "caller-pii-marker";
    const name = liveKitUpstreamChannelNameOf("app-1", `rtrail:open:${callerMarker}`);
    const ref = liveKitChannelSessionRefOf("app-1", `rtrail:open:${callerMarker}`, "web");
    expect(`${name}${ref}`).not.toContain(callerMarker);
  });
});

describe("livekit realtime rail — the short-lived client-access TTL bounds", () => {
  test("the TTL defaults minutes, never hours", () => {
    expect(CLIENT_ACCESS_DEFAULT_TTL_SECONDS).toBe(600);
    expect(CLIENT_ACCESS_HARD_CEILING_SECONDS).toBe(3600);
  });

  test("the TTL respects the session policy ceiling", () => {
    expect(clientAccessTtlOf(30_000, 600)).toBe(30);
    expect(clientAccessTtlOf(600_000, 600)).toBe(600);
  });

  test("the TTL respects the hard ceiling above any policy", () => {
    expect(clientAccessTtlOf(7_200_000, 600)).toBe(600);
    expect(clientAccessTtlOf(7_200_000, 100_000)).toBe(CLIENT_ACCESS_HARD_CEILING_SECONDS);
  });

  test("the TTL never drops below one second", () => {
    expect(clientAccessTtlOf(1, 600)).toBe(1);
  });
});

describe("livekit realtime rail — the failure normalization table", () => {
  test("the table covers exactly the five neutral kinds", () => {
    expect(Object.keys(LIVEKIT_FAILURE_NORMALIZATION).sort()).toEqual(
      ["authentication", "not-found", "quota", "unreachable", "upstream-error"].sort(),
    );
  });

  test("the entire reason vocabulary is vendor-free", () => {
    for (const entry of Object.values(LIVEKIT_FAILURE_NORMALIZATION)) {
      expect(entry.reason).toMatch(/^realtime rail /);
      expect(entry.reason).not.toMatch(
        /livekit|twirp|grpc|webrtc|participant|\broom\b|unavailable/i,
      );
    }
  });

  test("auth failures are terminal; capacity and reachability are retryable", () => {
    expect(classifyLiveKitFailure({ status: 401, message: "synthetic" })).toMatchObject({
      kind: "authentication",
      retryable: false,
      code: "AUTHENTICATION_FAILED",
    });
    expect(classifyLiveKitFailure({ status: 403, message: "synthetic" })).toMatchObject({
      kind: "authentication",
    });
    expect(classifyLiveKitFailure({ status: 404, message: "synthetic" })).toMatchObject({
      kind: "not-found",
      retryable: false,
    });
    expect(classifyLiveKitFailure({ status: 429, message: "synthetic" })).toMatchObject({
      kind: "quota",
      retryable: true,
    });
    expect(classifyLiveKitFailure({ status: 503, message: "synthetic" })).toMatchObject({
      kind: "quota",
      retryable: true,
    });
    expect(classifyLiveKitFailure({ status: 500, message: "synthetic" })).toMatchObject({
      kind: "unreachable",
      retryable: true,
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(classifyLiveKitFailure({ status: 400, message: "synthetic" })).toMatchObject({
      kind: "upstream-error",
      retryable: false,
      code: "PROVIDER_ERROR",
    });
  });

  test("transport-level failures classify as unreachable", () => {
    expect(classifyLiveKitFailure(new TypeError("fetch failed"))).toMatchObject({
      kind: "unreachable",
      retryable: true,
    });
    expect(classifyLiveKitFailure(new Error("connect ECONNREFUSED 127.0.0.1:7880"))).toMatchObject(
      { kind: "unreachable" },
    );
    expect(classifyLiveKitFailure(new Error("connect ETIMEDOUT upstream"))).toMatchObject({
      kind: "unreachable",
    });
  });

  test("unknown vendor failures collapse to the neutral upstream-error", () => {
    const classification = classifyLiveKitFailure(new Error("synthetic provider refusal"));
    expect(classification.kind).toBe("upstream-error");
    expect(classification.reason).toBe("realtime rail upstream refused the effect");
  });
});

describe("livekit realtime rail — the credential-envelope discipline", () => {
  test("the environment source resolves a fixed reference and redeems its envelope", async () => {
    const source = syntheticCredentialSource();
    const resolved = await source.resolve({
      applicationId: "app-1",
      tenantId: "tenant-1",
      channelKind: "web",
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.credentialRef).toBe("unit-synthetic-livekit-credential");
    const materialized = await source.materialize(resolved?.credentialRef ?? "", {
      attemptId: "unit-attempt",
      connectionId: resolved?.connectionId ?? "",
    });
    const envelope = JSON.parse(materialized.plaintext) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["apiKey", "apiSecret"]);
  });

  test("the environment source refuses an unknown reference (fail closed)", async () => {
    const source = syntheticCredentialSource();
    await expect(
      source.materialize("some-other-reference", {
        attemptId: "unit-attempt",
        connectionId: "unit-livekit",
      }),
    ).rejects.toBeInstanceOf(PlatformError);
  });
});

describe("livekit realtime rail — the in-memory idempotency ledger", () => {
  test("remember/lookup round-trips per (kind, application, key)", async () => {
    const ledger = createInMemoryLiveKitRailIdempotencyLedger();
    expect(await ledger.lookup("open", "app-1", "key-1")).toBeNull();
    await ledger.remember("open", "app-1", "key-1", {
      channelSessionRef: "rtch-x",
      deliveredAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await ledger.lookup("open", "app-1", "key-1")).toMatchObject({
      channelSessionRef: "rtch-x",
    });
    expect(await ledger.lookup("open", "app-1", "key-2")).toBeNull();
    expect(await ledger.lookup("deliver", "app-1", "key-1")).toBeNull();
  });
});

describe("livekit realtime rail — the environment composition gate (pinned both ways)", () => {
  test("a materialized credential set binds the REAL rail", () => {
    const binding = bindEnvironmentRealtimeRail({
      [LIVEKIT_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:7880",
      [LIVEKIT_RAIL_ENV_VARIABLES.apiKey]: SYNTHETIC_API_KEY,
      [LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]: SYNTHETIC_API_SECRET,
    });
    expect(binding.binding).toBe("livekit");
    expect(binding.isRealRail).toBe(true);
    expect(binding.liveKitUrl).toBe("http://127.0.0.1:7880");
    expect(binding.missing).toEqual([]);
    expect(binding.rail.descriptor.railCapabilityId).toBe(LIVEKIT_RAIL_CAPABILITY_ID);
    expect(binding.rail.descriptor.channelKinds).toEqual(LIVEKIT_RAIL_DEFAULT_CHANNEL_KINDS);
  });

  test("any missing piece keeps EXACTLY today's simulated shape", () => {
    const partial = bindEnvironmentRealtimeRail({
      [LIVEKIT_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:7880",
      [LIVEKIT_RAIL_ENV_VARIABLES.apiKey]: SYNTHETIC_API_KEY,
    });
    expect(partial.binding).toBe("simulated");
    expect(partial.isRealRail).toBe(false);
    expect(partial.liveKitUrl).toBeNull();
    expect(partial.missing).toEqual([LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]);
    expect(partial.rail.descriptor.railCapabilityId).toBe("simulated-realtime-rail");

    const empty = bindEnvironmentRealtimeRail({});
    expect(empty.binding).toBe("simulated");
    expect(empty.missing).toEqual([
      LIVEKIT_RAIL_ENV_VARIABLES.url,
      LIVEKIT_RAIL_ENV_VARIABLES.apiKey,
      LIVEKIT_RAIL_ENV_VARIABLES.apiSecret,
    ]);
    expect(empty.rail.descriptor.transportClass).toBe("realtime");
  });

  test("the gate never echoes credential values (secret hygiene)", () => {
    const binding = bindEnvironmentRealtimeRail({
      [LIVEKIT_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:7880",
      [LIVEKIT_RAIL_ENV_VARIABLES.apiKey]: SYNTHETIC_API_KEY,
      [LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]: SYNTHETIC_API_SECRET,
    });
    const serialized = JSON.stringify(binding);
    expect(serialized).not.toContain(SYNTHETIC_API_KEY);
    expect(serialized).not.toContain(SYNTHETIC_API_SECRET);
    const materialization = readLiveKitRailMaterialization({
      [LIVEKIT_RAIL_ENV_VARIABLES.url]: "http://127.0.0.1:7880",
      [LIVEKIT_RAIL_ENV_VARIABLES.apiKey]: SYNTHETIC_API_KEY,
      [LIVEKIT_RAIL_ENV_VARIABLES.apiSecret]: SYNTHETIC_API_SECRET,
    });
    expect(JSON.stringify(materialization)).not.toContain(SYNTHETIC_API_SECRET);
  });
});

describe("livekit realtime rail — the unreachable upstream (full-path normalization)", () => {
  test("openSession against a dead upstream rejects with the neutral unreachable shape", async () => {
    const rail = createLiveKitRealtimeRail({
      serverUrl: "http://127.0.0.1:1",
      credentialSource: syntheticCredentialSource(),
      requestTimeoutSeconds: 2,
    });
    const failure = await rail.openSession(openRequest("rtrail:open:unit-dead-1")).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PlatformError);
    const platformError = failure as PlatformError;
    expect(platformError.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(platformError.retryable).toBe(true);
    expect(platformError.message).toBe("realtime rail upstream unreachable");
  });

  test("deliverTurn against a dead upstream normalizes into the failure outcome", async () => {
    const rail = createLiveKitRealtimeRail({
      serverUrl: "http://127.0.0.1:1",
      credentialSource: syntheticCredentialSource(),
      requestTimeoutSeconds: 2,
    });
    const outcome = await rail.deliverTurn({
      applicationId: "00000000-0000-7000-8000-000000000021",
      sessionId: "session-unit-1",
      channelSessionRef: "rtch-unit-dead-channel",
      channelEpoch: 1,
      routeClass: "agent-answer",
      idempotencyKey: "rtrail:deliver:unit-dead-1",
      responseRef: "artifact://realtime/turns/unit-1",
      responsePreview: "bounded unit preview",
      cause: "unit delivery",
    });
    expect(outcome).toEqual({
      delivered: false,
      reason: "realtime rail upstream unreachable",
    });
  });

  test("an unbound credential source fails closed before any upstream call", async () => {
    const rail = createLiveKitRealtimeRail({
      serverUrl: "http://127.0.0.1:1",
      credentialSource: {
        async resolve() {
          return null;
        },
        async materialize() {
          throw new PlatformError({ code: "AUTHORIZATION_DENIED", message: "unreachable" });
        },
      },
    });
    const failure = await rail.openSession(openRequest("rtrail:open:unit-nocred-1")).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PlatformError);
    const platformError = failure as PlatformError;
    expect(platformError.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(platformError.message).toContain("no credential source bound");
  });

  test("a malformed credential envelope fails closed", async () => {
    const rail = createLiveKitRealtimeRail({
      serverUrl: "http://127.0.0.1:1",
      credentialSource: {
        async resolve() {
          return { connectionId: "unit-livekit", credentialRef: "unit-malformed" };
        },
        async materialize() {
          return { reference: "unit-malformed", plaintext: "not-json" };
        },
      },
    });
    await expect(rail.openSession(openRequest("rtrail:open:unit-badenv-1"))).rejects.toThrow(
      /credential envelope/,
    );
  });
});
