/**
 * Canonical JSON serialization — the determinism discipline of the
 * artifact substrate (WORK-008 / CTX-001 criterion 5, CTX-002).
 */

import { describe, expect, test } from "vitest";
import { canonicalJson, isCanonicalizable } from "../../../src/modules/artifacts/public";

describe("canonical JSON serialization", () => {
  test("object keys are sorted at every depth — insertion order never leaks", () => {
    const a = { z: 1, a: { y: [1, 2], b: "x" }, m: null };
    const b = { m: null, a: { b: "x", y: [1, 2] }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"b":"x","y":[1,2]},"m":null,"z":1}');
  });

  test("array order is data and is preserved", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  test("byte-stable under key shuffling for deeply nested documents", () => {
    const manifestish = (shuffle: boolean): unknown => {
      const inner = shuffle ? { two: 2, one: 1 } : { one: 1, two: 2 };
      return { payload: { items: [inner, { k: "v" }] }, kind: "compiled-context" };
    };
    expect(canonicalJson(manifestish(true))).toBe(canonicalJson(manifestish(false)));
  });

  test("scalars serialize exactly; integers stay integers", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-42)).toBe("-42");
    expect(canonicalJson(9007199254740991)).toBe("9007199254740991");
    expect(canonicalJson("héllo\n")).toBe('"héllo\\n"');
  });

  test("floating-point numbers are REJECTED (no-float determinism discipline)", () => {
    expect(() => canonicalJson(1.5)).toThrow(/floating-point/);
    expect(() => canonicalJson({ score: 0.25 })).toThrow(/floating-point/);
    expect(() => canonicalJson([1e-7])).toThrow(/floating-point/);
  });

  test("non-finite and unsafe numbers are REJECTED", () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
    expect(() => canonicalJson(2 ** 53)).toThrow(/safe range/);
  });

  test("undefined, functions, symbols, bigints are REJECTED (closed universe)", () => {
    expect(() => canonicalJson(undefined)).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
    expect(() => canonicalJson(Symbol("x"))).toThrow();
    expect(() => canonicalJson(1n)).toThrow();
  });

  test("empty containers and nested empties are stable", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({ a: {}, b: [] })).toBe('{"a":{},"b":[]}');
  });

  test("isCanonicalizable mirrors the serializer verdicts", () => {
    expect(isCanonicalizable({ a: [1, "two", null] })).toBe(true);
    expect(isCanonicalizable(0.5)).toBe(false);
    expect(isCanonicalizable({ f: () => 1 })).toBe(false);
  });
});
