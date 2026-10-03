/**
 * PPR-023 corpus asset builder — regenerates the two binary fixtures the
 * corpus declares (corpus/tasks.ts):
 *
 *  1. orange-swatch.png — DETERMINISTIC LOCAL SYNTHESIS: a 64×64
 *     solid-orange truecolor RGB PNG assembled chunk-by-chunk
 *     (IHDR/IDAT/IEND, node:zlib deflate, hand-rolled CRC-32).
 *     Byte-identical on every machine; NO AI surface is involved (the
 *     work order's classification rule: a locally synthesized fixture
 *     is not an AI edge).
 *
 *  2. known-phrase.wav — THE SUPPLY TTS SURFACE'S OWN RENDERING of the
 *     known phrase, obtained through the COMPLETE Zeck-delegated chain
 *     (adapter → Zeck public API → executions authority → model gateway
 *     → multi-surface GLM rail → supply /audio/tts) — exactly the route
 *     the speak-text corpus task drives, so the ASR round-trip
 *     (transcribe-memo) hears the supply's own voice. The request shape
 *     mirrors the corpus config's pinned TTS block (model glm-tts, the
 *     speakerVoice the config pins).
 *
 *     MEDIA QUOTA LAW: exactly ONE attempt, NO retry loop. A 429 or any
 *     other supply-side refusal leaves the asset ABSENT; the operator
 *     records the miss with its owner (operator-provider boundary —
 *     supply media quota) and the affected tests stay failed as
 *     quota-blocked. Never retried, never fabricated.
 *
 * Usage: bun run compat/openclaw/harness/build-corpus-assets.ts
 * Exit code 0 = both assets present; 1 = the wav is quota-blocked.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deflateSync } from "node:zlib";
import { createAdapterServer } from "../adapter/server";
import {
  KNOWN_PHRASE_TEXT,
  KNOWN_PHRASE_WAV_PATH,
  VISION_SWATCH_PATH,
} from "../corpus/tasks";
import { composeProofStack } from "./compose";

// ---------------------------------------------------------------------------
// The deterministic orange swatch (pure local synthesis, zero AI)
// ---------------------------------------------------------------------------

/** CRC-32 (ISO 3309, reflected) — the PNG chunk checksum, hand-rolled. */
function crc32(bytes: Buffer): number {
  let c = ~0;
  for (let i = 0; i < bytes.length; i += 1) {
    c ^= bytes[i]!;
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return ~c >>> 0;
}

/** Assemble one PNG chunk: length + type + data + CRC-32(type ∥ data). */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** A size×size solid-orange (RGB 255,165,0) truecolor PNG — deterministic. */
function solidOrangePng(size: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB (no alpha, no palette)
  const pixel = Buffer.from([0xff, 0xa5, 0x00]);
  const row = Buffer.concat([
    Buffer.from([0x00]), // filter type 0 (None) — one byte per scanline
    Buffer.concat(new Array<Buffer>(size).fill(pixel)),
  ]);
  const idat = deflateSync(Buffer.concat(new Array<Buffer>(size).fill(row)), {
    level: 9,
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// The known-phrase wav (one supply TTS attempt through the full chain)
// ---------------------------------------------------------------------------

console.log("[assets] composing the proof stack…");
const stack = await composeProofStack({
  minDispatchIntervalMs: 2000,
  retryCooldownMs: 15_000,
});
const adapter = await createAdapterServer({
  apiBaseUrl: stack.apiBaseUrl,
  token: stack.apiToken,
  applicationId: stack.applicationId,
});
console.log(`[assets] stack composed: adapter=${adapter.url}`);

/** The quota-block reason, or null when the wav landed. */
let blocked: string | null = null;

try {
  // -- 1. The deterministic swatch (always regenerable, no quota) --------
  mkdirSync(dirname(VISION_SWATCH_PATH), { recursive: true });
  const png = solidOrangePng(64);
  writeFileSync(VISION_SWATCH_PATH, png);
  console.log(
    `[assets] wrote ${VISION_SWATCH_PATH} (${png.length} bytes; deterministic solid-orange 64×64 RGB PNG)`,
  );

  // -- 2. ONE supply TTS attempt (MEDIA QUOTA LAW: no retries) ----------
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${adapter.url}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "glm-tts", // the corpus config's pinned TTS model
        input: KNOWN_PHRASE_TEXT,
        voice: "tongtong", // the corpus config's pinned speakerVoice
        response_format: "wav",
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    blocked = `delegated speech fetch failed: ${message}`;
    response = undefined as unknown as Response;
  }

  if (blocked === null) {
    if (response.status !== 200) {
      const detail = (await response.text()).slice(0, 200);
      blocked = `supply speech surface returned HTTP ${response.status}: ${detail}`;
    } else {
      const audio = Buffer.from(await response.arrayBuffer());
      const isRiff =
        audio.length > 44 &&
        audio.toString("ascii", 0, 4) === "RIFF" &&
        audio.toString("ascii", 8, 12) === "WAVE";
      if (!isRiff) {
        blocked =
          `speech surface returned ${audio.length} non-RIFF/WAV bytes ` +
          `(content-type ${response.headers.get("content-type") ?? "unknown"})`;
      } else {
        writeFileSync(KNOWN_PHRASE_WAV_PATH, audio);
        const log = adapter.requests()[adapter.requests().length - 1];
        console.log(
          `[assets] wrote ${KNOWN_PHRASE_WAV_PATH} (${audio.length} bytes; RIFF/WAV verified; ` +
            `Zeck execution ${log?.executionId ?? "?"} over edge ${log?.edgeId ?? "?"}; ` +
            `${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
        );
      }
    }
  }
} finally {
  adapter.close();
  await stack.close();
}

if (blocked !== null) {
  console.error(`[BLOCKED] known-phrase.wav: ${blocked}`);
  console.error(
    "[BLOCKED] owner: operator-provider boundary (supply media quota) — " +
      "ONE attempt spent, no retry (MEDIA QUOTA LAW); the asset stays absent " +
      "and the affected tests fail as quota-blocked.",
  );
  process.exit(1);
}
console.log("[assets] both corpus assets present.");
