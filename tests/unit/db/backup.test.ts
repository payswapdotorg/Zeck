/**
 * Unit tests — the logical backup/restore engine's deterministic
 * serialization (WORK-043 / D-02, AC8).
 *
 * The full drill against real PostgreSQL is
 * `tests/integration/postgres/backup-restore-drill.test.ts`; these
 * unit proofs pin: the cell serialization round-trip (dates, bytea,
 * jsonb, nulls) and the deterministic checksum input (stable row
 * serialization under identical values).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { deserializeCell, serializeCell } from "../../../src/platform/db/backup";
import { RestoreVerificationError } from "../../../src/platform/db/errors";

describe("backup cell serialization (deterministic, JSON-safe)", () => {
  test("dates serialize to ISO strings", () => {
    const date = new Date("2026-09-05T12:00:00.000Z");
    const serialized = serializeCell(date);
    expect(serialized).toBe("2026-09-05T12:00:00.000Z");
    expect(JSON.parse(JSON.stringify(serialized))).toBe("2026-09-05T12:00:00.000Z");
  });

  test("bytea buffers serialize to tagged hex and deserialize back to equal buffers", () => {
    const buffer = Buffer.from([0, 1, 2, 255, 128]);
    const serialized = serializeCell(buffer);
    expect(serialized).toEqual({ __zeck_bytea_hex__: "000102ff80" });
    const restored = deserializeCell(serialized);
    expect(Buffer.isBuffer(restored)).toBe(true);
    expect((restored as Buffer).equals(buffer)).toBe(true);
  });

  test("null, primitives and jsonb objects pass through JSON-safely", () => {
    expect(serializeCell(null)).toBeNull();
    expect(serializeCell(undefined)).toBeNull();
    expect(serializeCell("text")).toBe("text");
    expect(serializeCell(42)).toBe(42);
    expect(serializeCell(false)).toBe(false);
    const jsonb = { a: [1, "two", null], b: { nested: true } };
    expect(serializeCell(jsonb)).toEqual(jsonb);
    expect(JSON.parse(JSON.stringify(serializeCell(jsonb)))).toEqual(jsonb);
  });

  test("arrays serialize element-wise; deserialize yields JSON text (jsonb insert form)", () => {
    const value = [1, "two", null];
    expect(serializeCell(value)).toEqual(value);
    // The restore form is JSON TEXT — pg would otherwise serialize JS
    // arrays as PostgreSQL array literals, which is invalid JSON for
    // jsonb columns (the exact defect the drill surfaced).
    expect(deserializeCell(serializeCell(value))).toBe(JSON.stringify(value));
    expect(deserializeCell({ nested: { a: 1 } })).toBe('{"nested":{"a":1}}');
  });

  test("the row serialization is stable — identical values hash identically", () => {
    const row = {
      id: "a",
      created_at: serializeCell(new Date(0)),
      payload: { x: 1 },
      ciphertext: serializeCell(Buffer.from([9, 8, 7])),
    };
    const first = createHash("sha256").update(JSON.stringify(row), "utf8").digest("hex");
    const second = createHash("sha256")
      .update(
        JSON.stringify({
          id: "a",
          created_at: serializeCell(new Date(0)),
          payload: { x: 1 },
          ciphertext: serializeCell(Buffer.from([9, 8, 7])),
        }),
        "utf8",
      )
      .digest("hex");
    expect(first).toBe(second);
    // And a single changed byte changes the hash (verification discriminates).
    const changed = createHash("sha256")
      .update(
        JSON.stringify({
          id: "a",
          created_at: serializeCell(new Date(0)),
          payload: { x: 2 },
          ciphertext: serializeCell(Buffer.from([9, 8, 7])),
        }),
        "utf8",
      )
      .digest("hex");
    expect(changed).not.toBe(first);
  });
});

describe("restore error taxonomy", () => {
  test("RestoreVerificationError is the fail-closed verification signal", () => {
    const error = new RestoreVerificationError("verification failed");
    expect(error.name).toBe("RestoreVerificationError");
    expect(error).toBeInstanceOf(Error);
  });
});
