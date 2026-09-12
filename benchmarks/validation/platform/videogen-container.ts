/**
 * Pure MP4-container utilities for the video-generation slice (VAL-016).
 *
 * Verification is container / bounds / digest ONLY (the work order
 * forbids frame-level content claims — there is deliberately NO
 * frame-extraction dependency here): an ISO-BMFF `ftyp` box sniff by
 * magic bytes (never by file extension or provider mime type), the
 * platform's declared byte-size bounds, and the canonical sha256
 * digest. Everything is pure: no network, no environment, no
 * randomness — the same bytes always derive the same facts.
 *
 * MP4 `ftyp` validity (ISO/IEC 14496-12 §4.3): the file begins with a
 * box whose 32-bit big-endian size is at least 8 (size + type) and at
 * most the file's own length, whose type is `ftyp`, followed by the
 * 4-char major brand and 32-bit minor version. A payload failing this
 * shape is mechanically NOT a valid MP4 container — a real generated
 * clip must pass it, and a corrupted or wrong-modality payload fails
 * honestly.
 */

import { createHash } from "node:crypto";

/** The canonical payload digest: sha256 over the exact bytes, hex-16. */
export function mediaDigest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

/**
 * The platform's declared byte-size bounds for a generated video
 * artifact (mechanical sanity: a real 5-second generated clip is
 * kilobytes-to-megabytes; an empty or absurdly large payload fails).
 */
export const VIDEO_BYTE_BOUNDS = {
  minBytes: 1024,
  maxBytes: 268_435_456,
} as const;

/** Are the delivered bytes within the declared bounds? */
export function videoBytesWithinBounds(byteLength: number): boolean {
  return byteLength >= VIDEO_BYTE_BOUNDS.minBytes && byteLength <= VIDEO_BYTE_BOUNDS.maxBytes;
}

/** The mechanically derived MP4 container facts of a payload. */
export interface Mp4ContainerFacts {
  /** `mp4` iff a sane `ftyp` box opens the payload; `unknown` otherwise. */
  readonly container: "mp4" | "unknown";
  /** The 4-char major brand declared by the `ftyp` box (e.g. "isom"). */
  readonly majorBrand: string | null;
  /** The declared `ftyp` box size (bytes 0..4, big-endian). */
  readonly ftypBoxSize: number | null;
}

/**
 * Sniff the MP4 container by magic bytes: a sane `ftyp` box at offset 0
 * (size at bytes 0..4 big-endian, `ftyp` at bytes 4..8). Never by
 * extension, never by provider mime type.
 */
export function sniffMp4Container(bytes: Buffer): Mp4ContainerFacts {
  if (bytes.length < 16) {
    return { container: "unknown", majorBrand: null, ftypBoxSize: null };
  }
  const boxSize = bytes.readUInt32BE(0);
  const boxType = bytes.subarray(4, 8).toString("latin1");
  if (boxType !== "ftyp") {
    return { container: "unknown", majorBrand: null, ftypBoxSize: null };
  }
  if (boxSize < 8 || boxSize > bytes.length) {
    return { container: "unknown", majorBrand: null, ftypBoxSize: null };
  }
  const majorBrand = bytes.subarray(8, 12).toString("latin1");
  return { container: "mp4", majorBrand, ftypBoxSize: boxSize };
}

/**
 * Parse a rail-reported resolution string ("WxH" or "W*H") into
 * dimensions — the mechanical form of the "declared dimension bounds
 * where the rail reports them" (null when the rail reports nothing).
 */
export function parseRailResolution(reported: string): {
  readonly width: number;
  readonly height: number;
} | null {
  const match = /^(\d{2,5})[x*](\d{2,5})$/.exec(reported.trim());
  if (match === null) {
    return null;
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}
