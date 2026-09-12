/**
 * Pure raster utilities for the image-generation platform slice
 * (VAL-015): container sniffing (PNG/JPEG magic bytes), declared-
 * dimension parsing (PNG IHDR / JPEG SOF markers), a dependency-free
 * PNG RGB decoder and a coarse-grid changed-region analysis.
 *
 * Everything here is PURE: no network, no environment, no randomness,
 * no Zeck-internal imports. Mechanical verification only — these
 * utilities never judge aesthetics; they measure container validity,
 * declared dimensions and pixel-region change bounds.
 */

import { inflateSync } from "node:zlib";

/** The raster container kinds the rails deliver / verification accepts. */
export type RasterContainerKind = "png" | "jpeg" | "unknown";

/** A decoded RGB raster (three bytes per pixel, row-major). */
export interface DecodedRaster {
  readonly width: number;
  readonly height: number;
  /** length === width * height * 3 */
  readonly rgb: Uint8Array;
}

/** The raster's own declared dimensions parsed from its container. */
export interface RasterDimensions {
  readonly width: number;
  readonly height: number;
}

/** Saneness bounds for any accepted raster (mechanical, not aesthetic). */
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 8192;

// ---------------------------------------------------------------------------
// Container sniffing + declared dimensions (pure)
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Sniff the raster container kind from magic bytes (never by extension). */
export function sniffRasterContainer(bytes: Buffer): RasterContainerKind {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  return "unknown";
}

/**
 * Parse the raster's declared dimensions from its own container header
 * (PNG IHDR; JPEG SOFn markers). Returns null when the container does
 * not declare parseable dimensions — a mechanical fact, never a guess.
 */
export function parseRasterDimensions(bytes: Buffer): RasterDimensions | null {
  const kind = sniffRasterContainer(bytes);
  if (kind === "png") {
    return parsePngDimensions(bytes);
  }
  if (kind === "jpeg") {
    return parseJpegDimensions(bytes);
  }
  return null;
}

/** Dimensions are mechanically sane (bounded, positive). */
export function dimensionsAreSane(dims: RasterDimensions): boolean {
  return (
    Number.isInteger(dims.width) &&
    Number.isInteger(dims.height) &&
    dims.width >= MIN_DIMENSION &&
    dims.height >= MIN_DIMENSION &&
    dims.width <= MAX_DIMENSION &&
    dims.height <= MAX_DIMENSION
  );
}

function parsePngDimensions(bytes: Buffer): RasterDimensions | null {
  if (bytes.length < 33) {
    return null;
  }
  const chunkLength = bytes.readUInt32BE(8);
  const chunkType = bytes.subarray(12, 16).toString("ascii");
  if (chunkType !== "IHDR" || chunkLength < 13) {
    return null;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    return null;
  }
  return { width, height };
}

function parseJpegDimensions(bytes: Buffer): RasterDimensions | null {
  // Walk the marker segments to the first SOFn frame header.
  let offset = 2; // past SOI
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0x00;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone marker, no payload
      continue;
    }
    if (offset + 8 > bytes.length) {
      return null;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > bytes.length) {
        return null;
      }
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) {
        return null;
      }
      return { width, height };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dependency-free PNG → RGB decoding (pure)
// ---------------------------------------------------------------------------

const PNG_COLOR_GRAY = 0;
const PNG_COLOR_RGB = 2;
const PNG_COLOR_PALETTE = 3;
const PNG_COLOR_GRAY_ALPHA = 4;
const PNG_COLOR_RGBA = 6;

/**
 * Decode a PNG to an RGB raster (pure). Supports the color models image
 * rails actually emit (gray, RGB, palette, gray+alpha, RGBA) at bit
 * depth 8 (plus sub-byte palette depths); interlaced and 16-bit images
 * are honestly undecodable here (null) — the caller records that fact,
 * never a fabricated comparison.
 */
export function decodePngToRgb(bytes: Buffer): DecodedRaster | null {
  if (sniffRasterContainer(bytes) !== "png") {
    return null;
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const palette: number[][] = [];
  const idat: Buffer[] = [];
  while (offset + 8 <= bytes.length) {
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd > bytes.length) {
      return null;
    }
    const data = bytes.subarray(dataStart, dataEnd);
    if (chunkType === "IHDR") {
      if (chunkLength < 13) {
        return null;
      }
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? -1;
      interlace = data[12] ?? -1;
    } else if (chunkType === "PLTE") {
      for (let index = 0; index + 2 < data.length; index += 3) {
        palette.push([data[index] ?? 0, data[index + 1] ?? 0, data[index + 2] ?? 0]);
      }
    } else if (chunkType === "IDAT") {
      idat.push(data);
    } else if (chunkType === "IEND") {
      break;
    }
    offset = dataEnd + 4; // skip CRC
  }
  if (width === 0 || height === 0 || colorType < 0) {
    return null;
  }
  if (interlace !== 0) {
    return null; // Adam7 interlacing: honestly undecodable here
  }
  const channels =
    colorType === PNG_COLOR_GRAY
      ? 1
      : colorType === PNG_COLOR_RGB
        ? 3
        : colorType === PNG_COLOR_PALETTE
          ? 1
          : colorType === PNG_COLOR_GRAY_ALPHA
            ? 2
            : colorType === PNG_COLOR_RGBA
              ? 4
              : -1;
  if (channels < 0) {
    return null;
  }
  if (colorType === PNG_COLOR_PALETTE) {
    if (![1, 2, 4, 8].includes(bitDepth)) {
      return null;
    }
  } else if (bitDepth !== 8) {
    return null; // 16-bit depth: honestly undecodable here
  }
  if (width * height > 64 * 1024 * 1024) {
    return null; // mechanical guard (64 megapixels)
  }

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bitsPerPixel = channels * bitDepth;
  const bytesPerFullRow = Math.ceil((width * bitsPerPixel) / 8);
  const bytesPerPixel = Math.max(1, bitsPerPixel / 8); // unfilter stride
  const expected = (bytesPerFullRow + 1) * height;
  if (inflated.length < expected) {
    return null; // truncated stream: honestly undecodable
  }

  // Unfilter scanlines into packed pixel bytes.
  const raw = Buffer.alloc(bytesPerFullRow * height);
  const stride = bytesPerPixel;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (bytesPerFullRow + 1)] ?? 0;
    const src = inflated.subarray(
      y * (bytesPerFullRow + 1) + 1,
      y * (bytesPerFullRow + 1) + 1 + bytesPerFullRow,
    );
    const dst = raw.subarray(y * bytesPerFullRow, (y + 1) * bytesPerFullRow);
    const prior = y > 0 ? raw.subarray((y - 1) * bytesPerFullRow, y * bytesPerFullRow) : null;
    for (let x = 0; x < bytesPerFullRow; x += 1) {
      const filt = src[x] ?? 0;
      const left = x >= stride ? (dst[x - stride] ?? 0) : 0;
      const up = prior !== null ? (prior[x] ?? 0) : 0;
      const upLeft = prior !== null && x >= stride ? (prior[x - stride] ?? 0) : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = filt;
          break;
        case 1:
          value = filt + left;
          break;
        case 2:
          value = filt + up;
          break;
        case 3:
          value = filt + ((left + up) >> 1);
          break;
        case 4:
          value = filt + paeth(left, up, upLeft);
          break;
        default:
          return null; // unknown filter: honestly undecodable
      }
      dst[x] = value & 0xff;
    }
  }

  // Expand packed pixels to RGB triples.
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const out = pixelIndex * 3;
      if (colorType === PNG_COLOR_GRAY) {
        const v = raw[y * bytesPerFullRow + x] ?? 0;
        rgb[out] = v;
        rgb[out + 1] = v;
        rgb[out + 2] = v;
      } else if (colorType === PNG_COLOR_RGB) {
        const base = y * bytesPerFullRow + x * 3;
        rgb[out] = raw[base] ?? 0;
        rgb[out + 1] = raw[base + 1] ?? 0;
        rgb[out + 2] = raw[base + 2] ?? 0;
      } else if (colorType === PNG_COLOR_PALETTE) {
        const index = unpackPaletteIndex(raw, y * bytesPerFullRow, x, bitDepth);
        const entry = palette[index] ?? [0, 0, 0];
        rgb[out] = entry[0] ?? 0;
        rgb[out + 1] = entry[1] ?? 0;
        rgb[out + 2] = entry[2] ?? 0;
      } else if (colorType === PNG_COLOR_GRAY_ALPHA) {
        const v = raw[y * bytesPerFullRow + x * 2] ?? 0;
        rgb[out] = v;
        rgb[out + 1] = v;
        rgb[out + 2] = v;
      } else {
        const base = y * bytesPerFullRow + x * 4;
        rgb[out] = raw[base] ?? 0;
        rgb[out + 1] = raw[base + 1] ?? 0;
        rgb[out + 2] = raw[base + 2] ?? 0;
      }
    }
  }
  return { width, height, rgb };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}

function unpackPaletteIndex(row: Buffer, rowStart: number, x: number, bitDepth: number): number {
  if (bitDepth === 8) {
    return row[rowStart + x] ?? 0;
  }
  const bitsPerByte = 8 / bitDepth;
  const byteIndex = rowStart + Math.floor(x / bitsPerByte);
  const bitOffset = (x % bitsPerByte) * bitDepth;
  const byte = row[byteIndex] ?? 0;
  const shift = 8 - bitDepth - bitOffset;
  const mask = (1 << bitDepth) - 1;
  return (byte >> shift) & mask;
}

// ---------------------------------------------------------------------------
// Coarse-grid changed-region analysis (the pixel-region change bounds)
// ---------------------------------------------------------------------------

/** A normalized (fractional) pixel region: [x0, y0, x1, y1] each in [0, 1]. */
export type NormalizedRegion = readonly [number, number, number, number];

/** Convert a source-pixel region to normalized fractions. */
export function regionToNormalized(
  region: readonly [number, number, number, number],
  sourceWidth: number,
  sourceHeight: number,
): NormalizedRegion {
  return [
    region[0] / sourceWidth,
    region[1] / sourceHeight,
    region[2] / sourceWidth,
    region[3] / sourceHeight,
  ];
}

/** The coarse-grid change analysis between two decoded rasters. */
export interface ChangedRegionAnalysis {
  readonly cols: number;
  readonly rows: number;
  /** Row-major changed flags: changedCells[gy * cols + gx]. */
  readonly changedCells: readonly boolean[];
  readonly changedCellCount: number;
  readonly changedFraction: number;
  /** Normalized bbox of the changed cells, or null when nothing changed. */
  readonly changedBBox: NormalizedRegion | null;
  /** The per-cell mean channel-difference magnitudes (row-major). */
  readonly cellDiffs: readonly number[];
}

/**
 * Analyze which coarse grid cells changed between a deterministic
 * synthetic source and a transformed output. Both rasters are area-
 * averaged onto the SAME normalized grid (dimension mismatches are
 * handled by scaling, not by rejection); a cell is "changed" when its
 * mean per-channel difference exceeds the threshold. Robust to minor
 * resampling and compression tone shifts by construction.
 */
export function analyzeChangedRegion(
  source: DecodedRaster,
  output: DecodedRaster,
  options?: { readonly cols?: number; readonly rows?: number; readonly threshold?: number },
): ChangedRegionAnalysis {
  const cols = options?.cols ?? 16;
  const rows = options?.rows ?? 8;
  const threshold = options?.threshold ?? 20;
  const changedCells: boolean[] = [];
  const cellDiffs: number[] = [];
  let changedCellCount = 0;
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const sourceMean = cellMean(source, cols, rows, gx, gy);
      const outputMean = cellMean(output, cols, rows, gx, gy);
      const diff =
        (Math.abs(sourceMean[0] - outputMean[0]) +
          Math.abs(sourceMean[1] - outputMean[1]) +
          Math.abs(sourceMean[2] - outputMean[2])) /
        3;
      cellDiffs.push(diff);
      const changed = diff > threshold;
      changedCells.push(changed);
      if (changed) {
        changedCellCount += 1;
      }
    }
  }
  let changedBBox: NormalizedRegion | null = null;
  if (changedCellCount > 0) {
    let minX = cols;
    let minY = rows;
    let maxX = -1;
    let maxY = -1;
    for (let gy = 0; gy < rows; gy += 1) {
      for (let gx = 0; gx < cols; gx += 1) {
        if (changedCells[gy * cols + gx] === true) {
          minX = Math.min(minX, gx);
          minY = Math.min(minY, gy);
          maxX = Math.max(maxX, gx);
          maxY = Math.max(maxY, gy);
        }
      }
    }
    changedBBox = [minX / cols, minY / rows, (maxX + 1) / cols, (maxY + 1) / rows];
  }
  return {
    cols,
    rows,
    changedCells,
    changedCellCount,
    changedFraction: changedCellCount / (cols * rows),
    changedBBox,
    cellDiffs,
  };
}

/** Does any CHANGED grid cell intersect the normalized target region? */
export function changedCellsIntersectRegion(
  analysis: ChangedRegionAnalysis,
  region: NormalizedRegion,
): boolean {
  for (let gy = 0; gy < analysis.rows; gy += 1) {
    for (let gx = 0; gx < analysis.cols; gx += 1) {
      if (analysis.changedCells[gy * analysis.cols + gx] !== true) {
        continue;
      }
      const cellX0 = gx / analysis.cols;
      const cellX1 = (gx + 1) / analysis.cols;
      const cellY0 = gy / analysis.rows;
      const cellY1 = (gy + 1) / analysis.rows;
      if (cellX1 > region[0] && cellX0 < region[2] && cellY1 > region[1] && cellY0 < region[3]) {
        return true;
      }
    }
  }
  return false;
}

function cellMean(
  raster: DecodedRaster,
  cols: number,
  rows: number,
  gx: number,
  gy: number,
): [number, number, number] {
  const x0 = Math.floor((gx * raster.width) / cols);
  const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * raster.width) / cols));
  const y0 = Math.floor((gy * raster.height) / rows);
  const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * raster.height) / rows));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y0; y < Math.min(y1, raster.height); y += 1) {
    for (let x = x0; x < Math.min(x1, raster.width); x += 1) {
      const base = (y * raster.width + x) * 3;
      r += raster.rgb[base] ?? 0;
      g += raster.rgb[base + 1] ?? 0;
      b += raster.rgb[base + 2] ?? 0;
      count += 1;
    }
  }
  if (count === 0) {
    return [0, 0, 0];
  }
  return [r / count, g / count, b / count];
}
