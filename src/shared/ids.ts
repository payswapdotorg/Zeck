/**
 * UUIDv7 identifiers — sortable, durable identity for the platform
 * (`IMPLEMENTATION.md` §1: "UUIDv7 for sortable durable identifiers";
 * idempotency keys are caller-provided opaque strings and are NOT UUIDs).
 *
 * Pure and dependency-light: safe for domain code to use directly.
 * RFC 9562 layout:
 *
 * ```text
 *  0                   1                   2                   3
 *  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                           unix_ts_ms                          |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |          unix_ts_ms           |  ver  |       rand_a          |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |var|                        rand_b                             |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * |                            rand_b                             |
 * +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 * ```
 *
 * `rand_a` carries a 12-bit monotonic counter so identifiers generated within
 * the same millisecond still sort after each other. When the counter is
 * exhausted the timestamp is artificially advanced by one millisecond.
 */
/** Durable sortable identifier (UUIDv7 string form). */
export type Uuid = string;

/** Injectable randomness so deterministic tests are possible. */
export interface RandomSource {
  randomBytes(length: number): Uint8Array;
}

export interface Uuidv7GeneratorOptions {
  /** Injectable clock (milliseconds since epoch). Defaults to system time. */
  readonly now?: () => number;
  /** Injectable randomness. Defaults to `globalThis.crypto`. */
  readonly random?: RandomSource;
}

const defaultRandom: RandomSource = {
  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
};

const HEX = "0123456789abcdef";
const COUNTER_BITS = 12;
const COUNTER_MAX = (1 << COUNTER_BITS) - 1;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0xf];
    out += HEX[byte & 0xf];
  }
  return out;
}

/** A stateful, monotonic UUIDv7 generator. Create per context; see `uuidv7`. */
export type Uuidv7Generator = () => Uuid;

/**
 * Create a UUIDv7 generator with its own monotonic state.
 *
 * Successive calls never produce identifiers that sort backwards, even inside
 * the same millisecond; a backwards clock continues from the last known
 * timestamp.
 */
export function createUuidv7Generator(options: Uuidv7GeneratorOptions = {}): Uuidv7Generator {
  const now = options.now ?? Date.now;
  const random = options.random ?? defaultRandom;
  let lastTimestampMs = -1;
  let lastCounter = 0;

  return function nextUuidv7(): Uuid {
    let timestampMs = now();
    if (timestampMs < lastTimestampMs) {
      // Clock moved backwards: continue from the last known timestamp so
      // generated identifiers never sort before earlier ones.
      timestampMs = lastTimestampMs;
    }
    if (timestampMs === lastTimestampMs && lastCounter === COUNTER_MAX) {
      // Counter exhausted: advance the timestamp instead of reusing order.
      timestampMs += 1;
    }
    if (timestampMs === lastTimestampMs) {
      lastCounter += 1;
    } else {
      lastCounter = 0;
    }
    lastTimestampMs = timestampMs;

    const counter = lastCounter;
    const randB = random.randomBytes(8);
    const firstRandB = randB[0] ?? 0;

    const bytes = new Uint8Array(16);
    // 48-bit big-endian unix_ts_ms (division by powers of two is exact).
    bytes[0] = (timestampMs / 2 ** 40) & 0xff;
    bytes[1] = (timestampMs / 2 ** 32) & 0xff;
    bytes[2] = (timestampMs / 2 ** 24) & 0xff;
    bytes[3] = (timestampMs / 2 ** 16) & 0xff;
    bytes[4] = (timestampMs / 2 ** 8) & 0xff;
    bytes[5] = timestampMs & 0xff;
    // version(4 bits) + rand_a(12 bits) — rand_a is the monotonic counter.
    bytes[6] = (7 << 4) | ((counter >> 8) & 0x0f);
    bytes[7] = counter & 0xff;
    // variant(2 bits) + rand_b(62 bits).
    bytes[8] = 0x80 | (firstRandB & 0x3f);
    for (let i = 1; i < 8; i += 1) {
      bytes[8 + i] = randB[i] ?? 0;
    }

    const hex = toHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

/** Process-global monotonic UUIDv7 generator. */
export const uuidv7: Uuidv7Generator = createUuidv7Generator();

/** Structural check for any RFC 9562 UUID string form. */
export function isUuid(value: string): value is Uuid {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/** Check that an existing UUID string is a UUIDv7 (version nibble 7). */
export function isUuidv7(value: string): value is Uuid {
  return isUuid(value) && value[14] === "7";
}
