/**
 * Unit: micro-USD money primitives (budgets module, WORK-004).
 *
 * Money is integer minor units only: canonical decimal strings of
 * micro-USD, parsed to bigint for arithmetic. Floats, negatives, leading
 * zeros and out-of-range values are unrepresentable — the tests prove the
 * rejections, not just the happy paths.
 */

import { describe, expect, test } from "vitest";
import {
  addMicroUsd,
  compareMicroUsd,
  greaterThan,
  isMicroUsd,
  isMonthKey,
  MAX_MICRO_USD,
  microUsdFromBigint,
  monthKeyOf,
  parseMicroUsd,
  subMicroUsd,
} from "../../../src/modules/budgets/public";

describe("micro-USD money", () => {
  test("parses canonical non-negative integer decimal strings", () => {
    expect(parseMicroUsd("0")).toBe("0");
    expect(parseMicroUsd("1")).toBe("1");
    expect(parseMicroUsd("1000000")).toBe("1000000");
    expect(parseMicroUsd(MAX_MICRO_USD)).toBe(MAX_MICRO_USD);
  });

  test("parses bigint input canonically", () => {
    expect(microUsdFromBigint(123456789012345678n)).toBe("123456789012345678");
    expect(microUsdFromBigint(0n)).toBe("0");
  });

  test("rejects floats, decimals, signs, exponents and junk", () => {
    for (const bad of ["1.5", "-1", "+1", "1e6", "01", " 1", "1 ", "abc", "", "0x10", "1_000"]) {
      expect(() => parseMicroUsd(bad), bad).toThrow(RangeError);
      expect(isMicroUsd(bad), bad).toBe(false);
    }
    expect(() => parseMicroUsd(1.5 as unknown as string)).toThrow(RangeError);
    expect(() => parseMicroUsd(-1n)).toThrow(RangeError);
  });

  test("rejects amounts beyond the bigint column range", () => {
    expect(() => parseMicroUsd("1000000000000000000")).toThrow(RangeError);
    expect(() => microUsdFromBigint(10n ** 18n)).toThrow(RangeError);
  });

  test("arithmetic stays exact integer math (no float anywhere)", () => {
    const max = parseMicroUsd("999999999999999999");
    const aboveFloat = parseMicroUsd("9007199254740993");
    expect(addMicroUsd(max, parseMicroUsd("0"))).toBe("999999999999999999");
    // 2^53+1 is NOT representable as a float — bigint math keeps it exact.
    expect(addMicroUsd(aboveFloat, parseMicroUsd("1"))).toBe("9007199254740994");
    expect(subMicroUsd(max, parseMicroUsd("1"))).toBe("999999999999999998");
    expect(subMicroUsd(parseMicroUsd("10"), parseMicroUsd("10"))).toBe("0");
  });

  test("subtraction refuses negative results (balances never go negative)", () => {
    expect(() => subMicroUsd(parseMicroUsd("5"), parseMicroUsd("10"))).toThrow(RangeError);
  });

  test("comparison is numeric, not lexicographic", () => {
    expect(compareMicroUsd(parseMicroUsd("9"), parseMicroUsd("10"))).toBeLessThan(0);
    expect(compareMicroUsd(parseMicroUsd("10"), parseMicroUsd("9"))).toBeGreaterThan(0);
    expect(compareMicroUsd(parseMicroUsd("10"), parseMicroUsd("10"))).toBe(0);
    expect(greaterThan(parseMicroUsd("100"), parseMicroUsd("99"))).toBe(true);
    expect(greaterThan(parseMicroUsd("99"), parseMicroUsd("100"))).toBe(false);
  });

  test("UTC month keys are deterministic calendar windows", () => {
    expect(monthKeyOf(new Date("2026-03-01T00:00:00.000Z"))).toBe("2026-03");
    expect(monthKeyOf(new Date("2026-03-31T23:59:59.999Z"))).toBe("2026-03");
    expect(monthKeyOf(new Date("2026-04-01T00:00:00.000Z"))).toBe("2026-04");
    expect(monthKeyOf(new Date("2025-12-31T23:59:59.999Z"))).toBe("2025-12");
    expect(monthKeyOf(new Date("2026-01-01T00:00:01.000Z"))).toBe("2026-01");
    // Wall-clock irrelevance: 2026-03-01 00:30 UTC+5:30 (India) is still
    // 2026-02 in UTC — the window is derived from UTC only.
    expect(monthKeyOf(new Date(Date.UTC(2026, 1, 28, 19, 0, 0)))).toBe("2026-02");
  });

  test("month keys validate their shape", () => {
    expect(isMonthKey("2026-03")).toBe(true);
    expect(isMonthKey("2026-00")).toBe(false);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("26-03")).toBe(false);
    expect(isMonthKey("2026-3")).toBe(false);
  });
});
