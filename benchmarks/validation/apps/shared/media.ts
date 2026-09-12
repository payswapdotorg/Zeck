/**
 * Deterministic synthetic media fixtures (VAL-017).
 *
 * In-code generation (the VAL-003 "synthetic-media-recipe" pattern):
 * every image and audio clip is generated DETERMINISTICALLY from pure
 * drawing/synthesis primitives — the same recipe always yields the same
 * bytes (and the same sha256 digest). No external media, no
 * environment, no randomness. Ground-truth annotations travel with the
 * fixtures (the corpus rows' containsText terms are the oracle truth).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// A minimal raster canvas + PNG writer (pure, deterministic)
// ---------------------------------------------------------------------------

export interface Canvas {
  readonly width: number;
  readonly height: number;
  fillRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: readonly [number, number, number],
  ): void;
  drawCircle(cx: number, cy: number, r: number, color: readonly [number, number, number]): void;
  drawLine(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: readonly [number, number, number],
    thickness?: number,
  ): void;
  toPng(): Buffer;
}

export function createCanvas(
  width: number,
  height: number,
  background: readonly [number, number, number] = [255, 255, 255],
): Canvas {
  const pixels: [number, number, number][][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => [...background] as [number, number, number]),
  );
  const put = (x: number, y: number, color: readonly [number, number, number]): void => {
    if (y >= 0 && y < height && x >= 0 && x < width) {
      pixels[y]![x] = [color[0], color[1], color[2]] as [number, number, number];
    }
  };
  return {
    width,
    height,
    fillRect(x0, y0, x1, y1, color) {
      for (let y = Math.max(0, y0); y < Math.min(height, y1); y += 1) {
        for (let x = Math.max(0, x0); x < Math.min(width, x1); x += 1) {
          put(x, y, color);
        }
      }
    },
    drawCircle(cx, cy, r, color) {
      for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y += 1) {
        for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x += 1) {
          if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
            put(x, y, color);
          }
        }
      }
    },
    drawLine(x0, y0, x1, y1, color, thickness = 3) {
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps;
        const x = Math.round(x0 + (x1 - x0) * t);
        const y = Math.round(y0 + (y1 - y0) * t);
        for (let dy = -thickness; dy <= thickness; dy += 1) {
          for (let dx = -thickness; dx <= thickness; dx += 1) {
            put(x + dx, y + dy, color);
          }
        }
      }
    },
    toPng() {
      const raw = Buffer.concat(
        pixels.map((row) => Buffer.concat([Buffer.from([0]), Buffer.from(row.flat())])),
      );
      const chunk = (type: Buffer, data: Buffer): Buffer => {
        const body = Buffer.concat([type, data]);
        const crc = crc32(body);
        return Buffer.concat([
          Buffer.from(structPackUint32(data.length)),
          body,
          Buffer.from(structPackUint32(crc)),
        ]);
      };
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(width, 0);
      ihdr.writeUInt32BE(height, 4);
      ihdr[8] = 8; // bit depth
      ihdr[9] = 2; // color type RGB
      return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk(Buffer.from("IHDR"), ihdr),
        chunk(Buffer.from("IDAT"), zlibDeflate(raw)),
        chunk(Buffer.from("IEND"), Buffer.alloc(0)),
      ]);
    },
  };
}

import { deflateSync } from "node:zlib";

function zlibDeflate(data: Buffer): Buffer {
  return deflateSync(data, { level: 9 });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function structPackUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  bytes[0] = (value >>> 24) & 0xff;
  bytes[1] = (value >>> 16) & 0xff;
  bytes[2] = (value >>> 8) & 0xff;
  bytes[3] = value & 0xff;
  return bytes;
}

// ---------------------------------------------------------------------------
// Image fixtures (img-synthetic-scenes-v1 / img-synthetic-classify-v1)
// ---------------------------------------------------------------------------

const ROAD: readonly [number, number, number] = [120, 120, 120];
const BUS_YELLOW: readonly [number, number, number] = [240, 190, 20];
const WINDOW_BLUE: readonly [number, number, number] = [180, 220, 255];
const TIRE_BLACK: readonly [number, number, number] = [30, 30, 30];
const BIKE_FRAME: readonly [number, number, number] = [200, 40, 40];
const CAR_BLUE: readonly [number, number, number] = [40, 90, 200];

function drawBus(canvas: Canvas): void {
  canvas.fillRect(0, 112, canvas.width, canvas.height, ROAD);
  canvas.fillRect(24, 46, 216, 96, BUS_YELLOW);
  for (let i = 0; i < 6; i += 1) {
    canvas.fillRect(38 + i * 32, 58, 60 + i * 32 - (38 + i * 32), 84, WINDOW_BLUE);
  }
  canvas.drawCircle(70, 106, 14, TIRE_BLACK);
  canvas.drawCircle(184, 106, 14, TIRE_BLACK);
}

function drawBicycle(canvas: Canvas): void {
  canvas.drawCircle(60, 90, 34, TIRE_BLACK);
  canvas.drawCircle(190, 90, 34, TIRE_BLACK);
  canvas.drawLine(60, 90, 125, 40, BIKE_FRAME, 4);
  canvas.drawLine(125, 40, 190, 90, BIKE_FRAME, 4);
  canvas.drawLine(60, 90, 190, 90, BIKE_FRAME, 4);
  canvas.drawLine(125, 40, 125, 26, [80, 80, 80], 3);
  canvas.drawLine(115, 26, 150, 26, [80, 80, 80], 3);
  canvas.drawLine(190, 90, 205, 44, BIKE_FRAME, 4);
}

function drawCar(dim: boolean): (canvas: Canvas) => void {
  const body: readonly [number, number, number] = dim ? [28, 62, 140] : CAR_BLUE;
  return (canvas: Canvas) => {
    const scale = dim ? 0.7 : 1;
    canvas.fillRect(20, 62, 216, 100, body);
    canvas.fillRect(70, 26, 160, 62, body);
    canvas.fillRect(
      84,
      34,
      145,
      54,
      (dim ? [20, 44, 100] : WINDOW_BLUE) as readonly [number, number, number],
    );
    canvas.drawCircle(66, 104, 16, TIRE_BLACK);
    canvas.drawCircle(186, 104, 16, TIRE_BLACK);
    void scale;
  };
}

/** The image fixtures by key, generated deterministically. */
export function imageFixture(key: string): { readonly png: Buffer; readonly annotation: string } {
  switch (key) {
    case "scene-001": {
      // A street scene: a bus on a road (with a building strip).
      const canvas = createCanvas(256, 128);
      canvas.fillRect(0, 0, 256, 40, [150, 190, 230]); // sky
      canvas.fillRect(10, 20, 60, 40, [190, 190, 190]); // building
      drawBus(canvas);
      return { png: canvas.toPng(), annotation: "bus road building street" };
    }
    case "scene-004": {
      // A chart with a rising trend line and axes.
      const canvas = createCanvas(256, 128);
      canvas.drawLine(30, 10, 30, 110, [40, 40, 40], 2); // y axis
      canvas.drawLine(30, 110, 240, 110, [40, 40, 40], 2); // x axis
      for (let i = 0; i < 5; i += 1) {
        canvas.drawLine(50 + i * 45, 100 - i * 18, 95 + i * 45, 82 - i * 18, [200, 40, 40], 4);
      }
      return { png: canvas.toPng(), annotation: "chart line trend rising axis" };
    }
    case "img-c-001": {
      const canvas = createCanvas(256, 128);
      drawBus(canvas);
      return { png: canvas.toPng(), annotation: "bus" };
    }
    case "img-c-002": {
      const canvas = createCanvas(256, 128);
      drawBicycle(canvas);
      return { png: canvas.toPng(), annotation: "bicycle" };
    }
    case "img-c-003": {
      const canvas = createCanvas(256, 128);
      drawCar(true)(canvas);
      return { png: canvas.toPng(), annotation: "car low-light" };
    }
    case "img-corrupt": {
      // A genuinely corrupted image (PNG magic over garbage): the real
      // provider rejects it — the honest FAILED edge row.
      return { png: corruptPng(), annotation: "corrupt" };
    }
    default:
      throw new Error(`image fixture not materialized: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Audio fixtures (audio-synthetic-events-v1) — pure tone synthesis
// ---------------------------------------------------------------------------

/** Synthesize a WAV buffer deterministically from tone segments. */
export function synthesizeWav(
  segments: readonly {
    readonly freqHz: number;
    readonly durationMs: number;
    readonly envelope?: boolean;
  }[],
): Buffer {
  const sampleRate = 16000;
  const samples: number[] = [];
  for (const segment of segments) {
    const count = Math.floor((sampleRate * segment.durationMs) / 1000);
    for (let i = 0; i < count; i += 1) {
      const envelope = segment.envelope === false ? 1 : Math.exp((-3 * i) / count);
      samples.push(
        Math.round(9000 * envelope * Math.sin((2 * Math.PI * segment.freqHz * i) / sampleRate)),
      );
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    data.writeInt16LE(sample, index * 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The audio fixtures by key (deterministic synthesis). */
export function audioFixture(key: string): { readonly wav: Buffer; readonly annotation: string } {
  switch (key) {
    case "event-001":
      // A doorbell: one bell strike (chime) with a slow decay — the
      // canonical single-chime doorbell, stable against the rapid-beep
      // alarm signature (verified against the real audio rail).
      return {
        wav: synthesizeWav([{ freqHz: 587, durationMs: 1200 }]),
        annotation: "doorbell",
      };
    case "event-002":
      // An alarm: rapid high beeps with gaps.
      return {
        wav: synthesizeWav([
          ...Array.from({ length: 8 }, () => [
            { freqHz: 1400, durationMs: 100, envelope: false },
            { freqHz: 0, durationMs: 50, envelope: false },
          ]).flat(),
        ]),
        annotation: "alarm",
      };
    case "audio-corrupt":
      // A genuinely corrupted clip (RIFF/WAVE magic over garbage): the
      // real provider rejects it — the honest FAILED edge row.
      return {
        wav: corruptWav(),
        annotation: "corrupt",
      };
    default:
      throw new Error(`audio fixture not materialized: ${key}`);
  }
}

/** The canonical digest of a media fixture's bytes. */
export function mediaDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/** Deterministically corrupted PNG bytes (valid magic, garbage body). */
export function corruptPng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 0xff),
  ]);
}

/** Deterministically corrupted WAV bytes (RIFF/WAVE magic, garbage body). */
export function corruptWav(): Buffer {
  return Buffer.concat([Buffer.from("RIFF____WAVEjunk"), Buffer.alloc(64, 0x7f)]);
}

// ---------------------------------------------------------------------------
// Generation-prompt and image-edit fixtures (VAL-015 — additive, the
// VAL-003 "seeded prompt" recipe). Prompts are pinned text (the same
// key always yields the same prompt bytes, so the same request digest);
// edit fixtures couple a seeded edit instruction with the deterministic
// synthetic source image it is defined against and the instruction's
// declared TARGET REGION in source pixel coordinates — the mechanical
// ground truth for transformed-output verification (pixel-region change
// bounds; never aesthetic judgment).
// ---------------------------------------------------------------------------

/** A seeded text-to-image prompt fixture. */
export interface GenerationPromptFixture {
  readonly key: string;
  /** The exact prompt text dispatched (deterministic per key). */
  readonly prompt: string;
  /**
   * Structural ground-truth annotation (provenance only — recorded in
   * evidence; it is NEVER used as an aesthetic oracle).
   */
  readonly annotation: string;
}

/** A seeded image-edit (transformation) instruction fixture. */
export interface ImageEditFixture {
  readonly key: string;
  /** The exact edit instruction dispatched (deterministic per key). */
  readonly instruction: string;
  /** The synthetic source-image fixture key this edit is defined against. */
  readonly source: string;
  /**
   * [x0, y0, x1, y1] in SOURCE pixel coordinates — the region the
   * instruction targets (the fixture's own mechanical ground truth).
   */
  readonly targetRegion: readonly [number, number, number, number];
  readonly annotation: string;
}

const GENERATION_PROMPTS: readonly GenerationPromptFixture[] = [
  {
    key: "img-prompt-001",
    prompt:
      "A single large red filled circle centered on a plain white background. Flat minimal vector style, even lighting, no shadows, no text, no watermark.",
    annotation: "single red circle on white",
  },
  {
    key: "img-prompt-002",
    prompt:
      "Two flat shapes side by side on a plain light gray background: a yellow filled square on the left and a blue filled circle on the right, clearly separated. Minimal flat illustration, no text, no watermark.",
    annotation: "yellow square left, blue circle right",
  },
  {
    key: "img-prompt-003",
    prompt:
      "A simple flat illustration of a street scene: a small blue car on a straight gray road, a light blue sky above with the word ZECK written once in dark bold letters, minimal shapes, no watermark.",
    annotation: "car road sky text ZECK",
  },
];

const IMAGE_EDITS: readonly ImageEditFixture[] = [
  {
    key: "img-edit-001",
    instruction:
      "Recolor the body of the bus from yellow to a deep red. Keep the windows, wheels, road and the rest of the image exactly unchanged.",
    source: "img-c-001",
    targetRegion: [24, 46, 216, 120],
    annotation: "bus body recolored",
  },
  {
    key: "img-edit-002",
    instruction:
      "Replace the sky region at the top of the image with a dark night sky. Keep the building, the bus, the road and everything else exactly unchanged.",
    source: "scene-001",
    targetRegion: [0, 0, 256, 40],
    annotation: "sky replaced",
  },
  {
    key: "img-edit-003",
    instruction:
      "Remove the bicycle completely, filling the area it occupied with the plain white background. Keep everything else exactly unchanged.",
    source: "img-c-002",
    targetRegion: [26, 22, 224, 124],
    annotation: "bicycle removed",
  },
  {
    key: "img-edit-004",
    instruction: "Recolor the body of the bus to a deep blue.",
    source: "img-corrupt",
    targetRegion: [0, 0, 256, 128],
    annotation: "corrupt source rejected",
  },
];

/**
 * The seeded generation-prompt fixtures by key (deterministic). The
 * corpus's own empty-prompt edge row materializes as the empty prompt
 * (the platform rejects it BEFORE any paid dispatch — the honest
 * expected-FAILED row); unknown keys throw.
 */
export function generationPromptFixture(key: string): GenerationPromptFixture {
  if (key === "") {
    // The corpus row `image-generation.from-prompt.v1` "edge: empty prompt"
    // pins input { prompt: "" } — materialized here, never silently dropped.
    return { key: "", prompt: "", annotation: "empty prompt" };
  }
  const fixture = GENERATION_PROMPTS.find((candidate) => candidate.key === key);
  if (fixture === undefined) {
    throw new Error(`generation prompt fixture not materialized: ${key}`);
  }
  return fixture;
}

/** The seeded image-edit fixtures by key (deterministic; unknown keys throw). */
export function imageEditFixture(key: string): ImageEditFixture {
  const fixture = IMAGE_EDITS.find((candidate) => candidate.key === key);
  if (fixture === undefined) {
    throw new Error(`image edit fixture not materialized: ${key}`);
  }
  return fixture;
}

// ---------------------------------------------------------------------------
// VAL-014 voice fixtures (append-only union with the VAL-015/017 media
// families above; the voice family accessor is `voiceFixture` — the generic
// `audioFixture` above stays the VAL-017 audio-understanding family).
// ---------------------------------------------------------------------------

/** The canonical digest of a text fixture's bytes (sha256, hex, 16 chars). */
export function textDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * A syllabic-envelope tone: `syllables` amplitude-shaped bursts at a
 * speech-like fundamental, separated by gaps. This is the synthetic
 * "utterance shape" — an acoustic syllable profile with no lexical
 * content (its ground-truth annotation says exactly that).
 */
function syllabicUtteranceWav(options: {
  readonly freqHz: number;
  readonly syllables: number;
  readonly syllableMs: number;
  readonly gapMs: number;
}): Buffer {
  const segments: { freqHz: number; durationMs: number; envelope?: boolean }[] = [];
  for (let i = 0; i < options.syllables; i += 1) {
    segments.push({ freqHz: options.freqHz, durationMs: options.syllableMs });
    segments.push({ freqHz: 0, durationMs: options.gapMs, envelope: false });
  }
  return synthesizeWav(segments);
}

/** A voiced-beep command pattern (short rising pair / long low single). */
function commandWav(pattern: "rising-pair" | "long-low"): Buffer {
  if (pattern === "rising-pair") {
    return synthesizeWav([
      { freqHz: 880, durationMs: 120, envelope: false },
      { freqHz: 0, durationMs: 60, envelope: false },
      { freqHz: 1175, durationMs: 120, envelope: false },
    ]);
  }
  return synthesizeWav([{ freqHz: 330, durationMs: 400 }]);
}

// ---------------------------------------------------------------------------
// Audio fixtures (audio-synthetic-utterances/commands/dialog/briefings-v1)
// ---------------------------------------------------------------------------

/** A materialized audio voice fixture with its ground-truth annotation. */
export interface AudioVoiceFixture {
  readonly kind: "audio";
  readonly key: string;
  readonly wav: Buffer;
  /** The fixture's OWN ground-truth annotation (oracle provenance). */
  readonly annotation: string;
}

/** A materialized dialog turn-stream fixture (audio-synthetic-dialog-v1). */
export interface DialogFixture {
  readonly kind: "dialog";
  readonly key: string;
  /** The declared, bounded turn stream (user clip + platform reply phrase). */
  readonly turns: readonly {
    readonly clip: string;
    readonly replyPhrase: string;
    readonly voice: string;
  }[];
  /** The joined inbound stream WAV (user clips separated by gaps). */
  readonly stream: Buffer;
  readonly annotation: string;
}

const UTTERANCE_001 = syllabicUtteranceWav({
  freqHz: 220,
  syllables: 4,
  syllableMs: 180,
  gapMs: 90,
});
const BRIEFING_001 = synthesizeWav([
  { freqHz: 600, durationMs: 500 },
  { freqHz: 0, durationMs: 200, envelope: false },
  { freqHz: 800, durationMs: 500 },
  { freqHz: 0, durationMs: 200, envelope: false },
  { freqHz: 1000, durationMs: 500 },
]);

/** The audio fixtures by key (deterministic synthesis; append-only). */
export function voiceFixture(key: string): AudioVoiceFixture {
  switch (key) {
    case "utt-001":
      return {
        kind: "audio",
        key,
        wav: UTTERANCE_001,
        annotation: "utterance no-lexical-content syllables=4 f0=220hz",
      };
    case "brf-001":
      return {
        kind: "audio",
        key,
        wav: BRIEFING_001,
        annotation: "briefing no-lexical-content segments=3 topics=status,weather,reminder",
      };
    case "cmd-001":
      return {
        kind: "audio",
        key,
        wav: commandWav("rising-pair"),
        annotation: "command intent=confirm pattern=rising-pair",
      };
    case "cmd-002":
      return {
        kind: "audio",
        key,
        wav: commandWav("long-low"),
        annotation: "command intent=cancel pattern=long-low",
      };
    case "audio-corrupt":
      // A genuinely corrupted clip (RIFF/WAVE magic over garbage): the real
      // ASR provider rejects it — the honest FAILED edge row.
      return { kind: "audio", key, wav: corruptWav(), annotation: "corrupt" };
    default:
      throw new Error(`audio fixture not materialized: ${key}`);
  }
}

const DIALOG_GAP_MS = 300;
const SAMPLE_RATE = 16000;

/**
 * The joined inbound stream WAV: the session's user clips' PCM payloads
 * concatenated with fixed silence gaps (deterministic over the turn
 * clips' own bytes — the "dialog turn stream" the family declares).
 */
function dialogStream(turns: readonly { readonly clip: string }[]): Buffer {
  const chunks: Buffer[] = [];
  const gap = Buffer.alloc(((SAMPLE_RATE * DIALOG_GAP_MS) / 1000) * 2);
  for (const [index, turn] of turns.entries()) {
    const wav = voiceFixture(turn.clip).wav;
    if (index > 0) {
      chunks.push(gap);
    }
    chunks.push(wav.subarray(44));
  }
  return wrapPcm(Buffer.concat(chunks));
}

/** Wrap raw mono 16-bit PCM payload in the canonical 44-byte WAV header. */
function wrapPcm(data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * The dialog fixtures by key (audio-synthetic-dialog-v1): bounded, declared
 * turn streams with per-turn user clips and pinned platform reply phrases.
 */
export function dialogFixture(key: string): DialogFixture {
  switch (key) {
    case "dlg-001":
      return {
        kind: "dialog",
        key,
        turns: [
          { clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" },
          { clip: "utt-001", replyPhrase: "phrase-003", voice: "Cherry" },
        ],
        stream: dialogStream([{ clip: "cmd-001" }, { clip: "utt-001" }]),
        annotation: "dialog turns=2 stream=cmd-001+utt-001",
      };
    case "dlg-002":
      return {
        kind: "dialog",
        key,
        turns: [
          { clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" },
          { clip: "cmd-002", replyPhrase: "phrase-001", voice: "Cherry" },
        ],
        stream: dialogStream([{ clip: "cmd-001" }, { clip: "cmd-002" }]),
        annotation: "dialog turns=2 stream=cmd-001+cmd-002",
      };
    case "dlg-003":
      return {
        kind: "dialog",
        key,
        turns: [
          { clip: "utt-001", replyPhrase: "phrase-003", voice: "Cherry" },
          { clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" },
        ],
        stream: dialogStream([{ clip: "utt-001" }, { clip: "cmd-001" }]),
        annotation: "dialog turns=2 stream=utt-001+cmd-001",
      };
    case "dlg-004":
      return {
        kind: "dialog",
        key,
        turns: [{ clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" }],
        stream: dialogStream([{ clip: "cmd-001" }]),
        annotation: "dialog turns=1 stream=cmd-001",
      };
    case "dlg-005":
      return {
        kind: "dialog",
        key,
        turns: [
          { clip: "cmd-001", replyPhrase: "phrase-002", voice: "Cherry" },
          { clip: "cmd-002", replyPhrase: "phrase-001", voice: "Cherry" },
        ],
        stream: dialogStream([{ clip: "cmd-001" }, { clip: "cmd-002" }]),
        annotation: "dialog turns=2 stream=cmd-001+cmd-002",
      };
    default:
      throw new Error(`dialog fixture not materialized: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Phrase fixtures (the TTS input set with transcript ground truth)
// ---------------------------------------------------------------------------

/** A pinned phrase fixture with its transcript ground-truth terms. */
export interface PhraseFixture {
  readonly kind: "phrase";
  readonly key: string;
  /** The exact text synthesized by the REAL TTS rail. */
  readonly text: string;
  /**
   * The phrase's own ground-truth transcript terms (the ASR oracle truth
   * for the roundtrip rows — matched case-insensitively).
   */
  readonly terms: readonly string[];
  readonly annotation: string;
}

const PHRASES: readonly PhraseFixture[] = [
  {
    kind: "phrase",
    key: "phrase-001",
    text: "Good morning. The meeting is at nine tomorrow.",
    terms: ["meeting"],
    annotation: "utterance-transcript=good-morning-meeting-nine-tomorrow",
  },
  {
    kind: "phrase",
    key: "phrase-002",
    text: "Your appointment is confirmed for tomorrow at three.",
    terms: ["appointment", "tomorrow"],
    annotation: "utterance-transcript=appointment-confirmed-tomorrow-three",
  },
  {
    kind: "phrase",
    key: "phrase-003",
    text: "The flight departs at seven in the morning.",
    terms: ["flight"],
    annotation: "utterance-transcript=flight-departs-seven-morning",
  },
  {
    kind: "phrase",
    key: "phrase-blank",
    // The malformed-input edge: empty text is rejected BEFORE any dispatch.
    text: "",
    terms: [],
    annotation: "empty-text edge",
  },
];

const PHRASES_BY_KEY = new Map(PHRASES.map((phrase) => [phrase.key, phrase]));

/** The phrase fixtures by key (repository-pinned, append-only). */
export function phraseFixture(key: string): PhraseFixture {
  const phrase = PHRASES_BY_KEY.get(key);
  if (phrase === undefined) {
    throw new Error(`phrase fixture not materialized: ${key}`);
  }
  return phrase;
}

// ---------------------------------------------------------------------------
// The materialization surface
// ---------------------------------------------------------------------------

/** The VAL-003 corpus manifest families this module materializes (VAL-014). */
export const MATERIALIZED_VOICE_FIXTURE_SETS: readonly string[] = [
  "audio-synthetic-utterances-v1",
  "audio-synthetic-commands-v1",
  "audio-synthetic-dialog-v1",
  "audio-synthetic-briefings-v1",
];

/** Every audio fixture key materialized here, in stable order. */
export const MATERIALIZED_VOICE_FIXTURE_KEYS: readonly string[] = [
  "utt-001",
  "brf-001",
  "cmd-001",
  "cmd-002",
  "audio-corrupt",
];

/** Every phrase fixture key materialized here, in stable order. */
export const MATERIALIZED_PHRASE_FIXTURE_KEYS: readonly string[] = PHRASES.map((p) => p.key);

/**
 * Materialize any voice fixture by key (audio, dialog or phrase). Absent
 * keys throw (an absent fixture is a NOT RUN boundary for the RUNNER,
 * never a silent empty dispatch).
 */
export function materializeVoiceFixture(
  key: string,
): AudioVoiceFixture | DialogFixture | PhraseFixture {
  if (PHRASES_BY_KEY.has(key)) {
    return phraseFixture(key);
  }
  if (key.startsWith("dlg-")) {
    return dialogFixture(key);
  }
  return voiceFixture(key);
}
