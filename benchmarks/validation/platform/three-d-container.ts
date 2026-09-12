/**
 * Pure 3D-container utilities for the three-d slice (VAL-018).
 *
 * Verification is container / bounds / digest ONLY — the work order's
 * own rule for 3D outputs ("verify by container validity and
 * digest"): magic-byte container sniffing for the three canonical
 * exchange formats a 3D-generation rail delivers (binary glTF `.glb`,
 * binary STL, text OBJ — never by file extension and never by a
 * provider-declared mime type), the platform's declared byte-size
 * bounds, and the canonical sha256 digest. Everything is pure: no
 * network, no environment, no randomness — the same bytes always
 * derive the same facts.
 *
 * These utilities are the OFFLINE verification machinery: they execute
 * today (unit and discrimination tests over the deterministic
 * synthetic containers in apps/shared/media.ts) and they are the exact
 * mechanical criteria a REAL authorized 3D rail's outputs will be
 * judged by when operator-authorized 3D access exists (the surfaced
 * access requirement in platform/three-d.ts). No rail output is ever
 * claimed here — no authorized 3D rail exists.
 *
 * Container validity (mechanical, per spec):
 *   * binary glTF (`.glb`): the file begins with the magic `glTF`
 *     (0x46546C67, little-endian), a uint32 version and a uint32 total
 *     length that is at least 12 and at most the file's own length
 *     (ISO/IEC 12100 §5.3 GLB header);
 *   * binary STL: an 80-byte header followed by a uint32
 *     little-endian triangle count N whose implied length
 *     84 + 50·N equals the file's own byte length;
 *   * text OBJ: the first non-empty line opens with an OBJ statement
 *     keyword and the text contains at least one `v` vertex line and
 *     one `f` face line within the sniff window.
 */

import { mediaDigest } from "../apps/shared/media";

/** The canonical payload digest: sha256 over the exact bytes, hex-16. */
export { mediaDigest };

/** The 3D container kinds the platform verifies mechanically. */
export type ThreeDContainerKind = "gltf-binary" | "stl" | "obj" | "unknown";

/** The mechanically derived container facts of a 3D payload. */
export interface ThreeDContainerFacts {
  readonly container: ThreeDContainerKind;
  /** Mechanically derived detail (never a provider claim). */
  readonly detail: string | null;
}

/**
 * The platform's declared byte-size bounds for a generated 3D artifact
 * (mechanical sanity: a real generated mesh/scene is dozens of bytes
 * to megabytes; an empty or absurdly large payload fails).
 */
export const THREE_D_BYTE_BOUNDS = {
  minBytes: 64,
  maxBytes: 268_435_456,
} as const;

/** Are the delivered bytes within the declared bounds? */
export function threeDBytesWithinBounds(byteLength: number): boolean {
  return byteLength >= THREE_D_BYTE_BOUNDS.minBytes && byteLength <= THREE_D_BYTE_BOUNDS.maxBytes;
}

/**
 * The OBJ sniff window: text-structure facts are derived from the
 * first 1 MiB of the payload (a valid OBJ opens with its geometry
 * well inside the window; the counts are window counts by definition).
 */
const OBJ_SNIFF_WINDOW_BYTES = 1_048_576;

const OBJ_FIRST_LINE = /^(?:#|v|vn|vt|vp|f|o|g|s|mtllib|usemtl)\s/;

/**
 * Sniff the 3D container by magic bytes / mechanical structure — never
 * by extension, never by provider-declared mime type.
 */
export function sniffThreeDContainer(bytes: Buffer): ThreeDContainerFacts {
  // 1. Binary glTF (.glb): `glTF` magic + sane total length.
  if (bytes.length >= 12) {
    const magic = bytes.subarray(0, 4).toString("latin1");
    if (magic === "glTF") {
      const version = bytes.readUInt32LE(4);
      const totalLength = bytes.readUInt32LE(8);
      if (totalLength >= 12 && totalLength <= bytes.length) {
        return { container: "gltf-binary", detail: `version:${version},length:${totalLength}` };
      }
      return { container: "unknown", detail: `gltf-magic-invalid-length:${totalLength}` };
    }
  }
  // 2. Binary STL: 80-byte header + uint32 triangle count + 50 bytes
  //    per triangle, exactly matching the file length.
  if (bytes.length >= 84) {
    const triangles = bytes.readUInt32LE(80);
    if (bytes.length === 84 + 50 * triangles) {
      return { container: "stl", detail: `triangles:${triangles}` };
    }
  }
  // 3. Text OBJ: leading OBJ statement + at least one vertex and one
  //    face line within the sniff window.
  const window = bytes.subarray(0, Math.min(bytes.length, OBJ_SNIFF_WINDOW_BYTES)).toString("utf8");
  const lines = window.split("\n");
  const firstNonEmpty = lines.find((line) => line.trim().length > 0) ?? "";
  if (OBJ_FIRST_LINE.test(firstNonEmpty.trim())) {
    let vertices = 0;
    let faces = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("v ") || trimmed === "v") {
        vertices += 1;
      } else if (trimmed.startsWith("f ") || trimmed === "f") {
        faces += 1;
      }
    }
    if (vertices > 0 && faces > 0) {
      return { container: "obj", detail: `vertices:${vertices},faces:${faces}` };
    }
  }
  return { container: "unknown", detail: null };
}
