/**
 * The Lead's §15 credentialed-run probe — the EXTERNAL LiveKit participant-join proof.
 *
 * Boundary exercised: a real MANAGED LiveKit plane (non-loopback, WSS/TLS) with an
 * owner-delivered short-lived join grant. Proves: the endpoint is real and serving;
 * the grant is authenticated and room-authorized; the participant is admitted and
 * the signaling handshake progresses through the WebRTC offer. Deliberately does
 * NOT exercise: the admin/server-SDK lifecycle (needs the API keypair SECRET, not
 * a join grant) or the media/data plane (needs an RTCPeerConnection stack).
 *
 * Usage (the Lead's local credential store — the token material is NEVER committed):
 *   LIVEKIT_WS_URL=wss://… LIVEKIT_JOIN_TOKEN=eyJ… bun run scripts/lead-livekit-join-probe.ts
 *
 * Evidence of record: deploy/evidence/ppr-009-live-join.json (the 2026-09-23 run).
 */
import { SignalRequest, SignalResponse } from "@livekit/protocol";

const url = process.env.LIVEKIT_WS_URL;
const token = process.env.LIVEKIT_JOIN_TOKEN;
if (!url || !token) {
  console.error("missing LIVEKIT_WS_URL / LIVEKIT_JOIN_TOKEN (the Lead's credential store)");
  process.exit(2);
}

// Decode the JWT payload (no secret material — claims only) for the record.
const payloadB64 = token.split(".")[1]!;
const payloadJson = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));

const t0 = Date.now();
const result: Record<string, unknown> = {
  probe: "livekit-cloud-participant-join",
  endpoint: url,
  probeStartedAtEpoch: Math.floor(t0 / 1000),
  tokenClaims: {
    iss: payloadJson.iss,
    sub: payloadJson.sub,
    identity: payloadJson.identity,
    room: payloadJson.video?.room,
    grants: {
      roomJoin: payloadJson.video?.roomJoin,
      canPublish: payloadJson.video?.canPublish,
      canSubscribe: payloadJson.video?.canSubscribe,
      canPublishData: payloadJson.video?.canPublishData,
    },
    iat: payloadJson.iat,
    exp: payloadJson.exp,
    ttlSeconds: payloadJson.exp - payloadJson.iat,
  },
};

const ws = new WebSocket(
  `${url}/rtc?access_token=${encodeURIComponent(token)}&auto_subscribe=0&sdk=js&version=2.13.5&protocol=17`,
  "livekit",
);

const finish = (code: number) => {
  result.totalElapsedMs = Date.now() - t0;
  console.log("PROBE_RESULT_BEGIN");
  console.log(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  console.log("PROBE_RESULT_END");
  process.exit(code);
};

const timeout = setTimeout(() => {
  result.outcome = "timeout";
  finish(3);
}, 45_000);

ws.addEventListener("open", () => {
  result.wsOpen = true;
  result.wsOpenElapsedMs = Date.now() - t0;
});

ws.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data as unknown;
  if (typeof data === "string") {
    result.textFrame = data.slice(0, 500);
    return;
  }
  let bytes: Uint8Array;
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  } else {
    result.outcome = "unexpected-frame-type";
    clearTimeout(timeout);
    finish(6);
    return;
  }
  try {
    const res = SignalResponse.fromBinary(bytes);
    const kind = res.message?.case ?? "unknown";
    if (kind === "join" && res.message.value) {
      const join = res.message.value;
      result.outcome = "joined";
      result.joinElapsedMs = Date.now() - t0;
      result.joinResponse = {
        roomName: join.room?.name,
        roomSid: join.room?.sid,
        roomCreationTime: join.room?.creationTime,
        roomNumParticipants: join.room?.numParticipants,
        serverVersion: join.serverVersion,
        serverRegion: join.serverRegion,
        participantIdentity: join.participant?.identity,
        participantSid: join.participant?.sid,
        participantCanPublish: join.participant?.canPublish,
        participantCanSubscribe: join.participant?.canSubscribe,
        participantCanPublishData: join.participant?.canPublishData,
      };
      // Clean leave (best-effort — the join proof is already complete here).
      try {
        const leave = SignalRequest.toBinary(
          SignalRequest.create({ message: { case: "leave", value: {} } }),
        );
        ws.send(leave);
      } catch {
        /* best-effort */
      }
      setTimeout(() => {
        clearTimeout(timeout);
        try {
          ws.close(1000, "probe-complete");
        } catch {
          /* ignore */
        }
        finish(0);
      }, 300);
    } else if (kind === "error") {
      result.outcome = "server-error";
      result.serverError = res.message.value;
      clearTimeout(timeout);
      finish(4);
    } else {
      result.otherMessages = [...((result.otherMessages as string[]) ?? []), kind];
    }
  } catch (err) {
    result.outcome = "decode-failure";
    result.decodeError = String(err);
    clearTimeout(timeout);
    finish(5);
  }
});

ws.addEventListener("close", (ev: CloseEvent) => {
  result.wsClosed = { code: ev.code, reason: ev.reason };
  if (result.outcome !== "joined" && result.outcome !== "timeout") {
    result.outcome = "closed-before-join";
    clearTimeout(timeout);
    finish(2);
  }
});

ws.addEventListener("error", () => {
  if (!("outcome" in result)) {
    result.outcome = "ws-error";
    clearTimeout(timeout);
    finish(1);
  }
});
