/**
 * Unit — tool field schemas: the pure shape validation of tool inputs and
 * outputs (WORK-010). Closed contracts (undeclared fields rejected),
 * required-field enforcement, primitive type checking, nullability.
 */

import { describe, expect, test } from "vitest";
import { checkAgainstSchema, isToolFieldSchema } from "../../../src/modules/tools/public";

const schema = {
  fields: [
    { name: "operation", type: "string" as const, required: true },
    { name: "precision", type: "number" as const, required: false },
    { name: "flag", type: "boolean" as const, required: false },
    { name: "meta", type: "object" as const, required: false, nullable: true },
    { name: "tags", type: "array" as const, required: false },
  ],
};

describe("tool field schemas", () => {
  test("valid payload with all declared fields passes", () => {
    const check = checkAgainstSchema(schema, {
      operation: "add",
      precision: 2,
      flag: true,
      meta: { a: 1 },
      tags: [1, 2],
    });
    expect(check).toEqual({ ok: true });
  });

  test("optional fields may be absent", () => {
    expect(checkAgainstSchema(schema, { operation: "add" })).toEqual({ ok: true });
  });

  test("required fields must be present", () => {
    const check = checkAgainstSchema(schema, {});
    expect(check).toEqual({
      ok: false,
      reason: expect.stringContaining("operation"),
      field: "operation",
    });
  });

  test("undeclared fields are rejected (contracts are closed)", () => {
    const check = checkAgainstSchema(schema, { operation: "add", surprise: 1 });
    expect(check).toEqual({
      ok: false,
      reason: expect.stringContaining("undeclared field"),
      field: "surprise",
    });
  });

  test("primitive type violations are rejected with the field name", () => {
    expect((checkAgainstSchema(schema, { operation: 42 }) as { field?: string }).field).toBe(
      "operation",
    );
    expect((checkAgainstSchema(schema, { precision: "2" }) as { field?: string }).field).toBe(
      "precision",
    );
    expect((checkAgainstSchema(schema, { flag: "yes" }) as { field?: string }).field).toBe("flag");
    expect((checkAgainstSchema(schema, { meta: [1] }) as { field?: string }).field).toBe("meta");
    expect((checkAgainstSchema(schema, { tags: "a,b" }) as { field?: string }).field).toBe("tags");
  });

  test("null is only accepted for nullable fields", () => {
    expect(checkAgainstSchema(schema, { operation: null }).ok).toBe(false);
    expect(checkAgainstSchema(schema, { operation: "add", meta: null }).ok).toBe(true);
  });

  test("non-object payloads are rejected", () => {
    expect(checkAgainstSchema(schema, null).ok).toBe(false);
    expect(checkAgainstSchema(schema, "add").ok).toBe(false);
    expect(checkAgainstSchema(schema, [1]).ok).toBe(false);
  });

  test("NaN/infinite numbers are not numbers here", () => {
    expect(checkAgainstSchema(schema, { operation: "add", precision: Number.NaN }).ok).toBe(false);
    expect(
      checkAgainstSchema(schema, { operation: "add", precision: Number.POSITIVE_INFINITY }).ok,
    ).toBe(false);
  });

  test("schema shape checking detects malformed schemas", () => {
    expect(isToolFieldSchema(schema)).toBe(true);
    expect(isToolFieldSchema({ fields: [] })).toBe(true);
    expect(
      isToolFieldSchema({ fields: [{ name: "a", type: "string", required: true, extra: 1 }] }),
    ).toBe(true);
    expect(isToolFieldSchema({ fields: "nope" })).toBe(false);
    expect(isToolFieldSchema({ fields: [{ name: "", type: "string", required: true }] })).toBe(
      false,
    );
    expect(
      isToolFieldSchema({
        fields: [
          { name: "a", type: "string", required: true },
          { name: "a", type: "string", required: false },
        ],
      }),
    ).toBe(false);
    expect(isToolFieldSchema({ fields: [{ name: "a", type: "vector", required: true }] })).toBe(
      false,
    );
  });
});
