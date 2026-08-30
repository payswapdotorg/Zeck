/**
 * Unit tests — UUIDv7 identifiers (`src/shared/ids.ts`).
 *
 * `IMPLEMENTATION.md` §1: "UUIDv7 for sortable durable identifiers".
 * Proves format correctness, uniqueness, monotonic ordering, counter
 * behavior inside one millisecond, tick-over on counter exhaustion and
 * clock-regression safety. Deterministic cases use dedicated generators with
 * injected time/randomness.
 */
import { describe, expect, test } from "vitest";
import {
  createUuidv7Generator,
  isUuid,
  isUuidv7,
  type RandomSource,
  uuidv7,
} from "../../src/shared/ids";

const zeroRandom: RandomSource = {
  randomBytes(length: number): Uint8Array {
    return new Uint8Array(length);
  },
};

function fixedRandom(bytes: number[]): RandomSource {
  return {
    randomBytes(length: number): Uint8Array {
      return Uint8Array.from(bytes.slice(0, length));
    },
  };
}

describe("uuidv7 format", () => {
  test("produces RFC 9562 string form with version 7", () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(isUuidv7(id)).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("is deterministic with injected time and randomness", () => {
    const generate = createUuidv7Generator({ now: () => 0, random: zeroRandom });
    expect(generate()).toBe("00000000-0000-7000-8000-000000000000");
    expect(generate()).toBe("00000000-0000-7001-8000-000000000000");
  });

  test("embeds the unix millisecond timestamp", () => {
    const timestamp = 1_750_000_000_000; // 2025-06-15T16:53:20Z
    const generate = createUuidv7Generator({ now: () => timestamp, random: zeroRandom });
    const hex = generate().replaceAll("-", "");
    const embedded = Number.parseInt(hex.slice(0, 12), 16);
    expect(embedded).toBe(timestamp);
  });
});

describe("uuidv7 uniqueness and ordering", () => {
  test("10_000 generated identifiers are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      seen.add(uuidv7());
    }
    expect(seen.size).toBe(10_000);
  });

  test("generated identifiers sort monotonically", () => {
    const ids = Array.from({ length: 2_000 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  test("same-millisecond identifiers stay unique and ordered via the counter", () => {
    const generate = createUuidv7Generator({ now: () => 1_234_567 });
    const ids = Array.from({ length: 5_000 }, () => generate());
    expect(new Set(ids).size).toBe(5_000);
    expect([...ids].sort()).toEqual(ids);
  });

  test("counter exhaustion ticks the timestamp forward instead of repeating order", () => {
    const generate = createUuidv7Generator({ now: () => 42 });
    const ids = Array.from({ length: 4_098 }, () => generate());
    expect(new Set(ids).size).toBe(4_098);
    expect([...ids].sort()).toEqual(ids);
  });

  test("a backwards clock never produces an identifier that sorts earlier", () => {
    let clock = 10_000;
    const generate = createUuidv7Generator({ now: () => clock, random: zeroRandom });
    const first = generate();
    clock = 5_000; // clock jumps backwards
    const second = generate();
    expect(second > first).toBe(true);
  });

  test("random material flows into rand_b", () => {
    const generate = createUuidv7Generator({
      now: () => 0,
      random: fixedRandom([0, 0, 0, 0, 0, 0, 0, 0xff]),
    });
    // bytes 8..15 = 80 00 00 00 00 00 00 ff (variant bits + rand_b)
    expect(generate()).toBe("00000000-0000-7000-8000-0000000000ff");
  });
});

describe("uuid validation helpers", () => {
  test("isUuid accepts canonical UUIDs and rejects malformed values", () => {
    expect(isUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isUuid("123e4567e89b42d3a456426614174000")).toBe(false);
    expect(isUuid("123e4567-e89b-42d3-a456-42661417400")).toBe(false);
    expect(isUuid("123e4567-e89b-42d3-a456-42661417400g")).toBe(false);
    expect(isUuid("")).toBe(false);
  });

  test("isUuidv7 rejects other versions", () => {
    expect(isUuidv7("123e4567-e89b-72d3-a456-426614174000")).toBe(true);
    expect(isUuidv7("123e4567-e89b-42d3-a456-426614174000")).toBe(false);
  });
});
