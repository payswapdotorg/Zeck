/**
 * Unit: funding modes and deterministic funding precedence
 * (budgets module, WORK-004; BUD-003).
 *
 * The funding precedence is FROZEN: byok > subsidy > user > developer. A
 * mode selects the eligible subsequence of that order; wallet selection is
 * a single-source draw in that order. The tests pin the mapping and prove
 * every mode's order is a subsequence of the frozen precedence (so
 * selection can never depend on insertion order or map iteration).
 */

import { describe, expect, test } from "vitest";
import {
  BUDGET_CHECK_ORDER,
  eligibleWalletSources,
  FUNDING_MODES,
  FUNDING_PRECEDENCE,
  isFundingMode,
  modeRequiresUser,
} from "../../../src/modules/budgets/public";

describe("funding modes and precedence", () => {
  test("the five canonical funding modes exist and nothing else validates", () => {
    expect(FUNDING_MODES).toEqual(["developer", "user", "byok", "hybrid", "subsidy"]);
    for (const mode of FUNDING_MODES) {
      expect(isFundingMode(mode)).toBe(true);
    }
    for (const bad of ["", "platform", "BYOK", "mixed", "user,developer"]) {
      expect(isFundingMode(bad)).toBe(false);
    }
  });

  test("funding precedence is frozen: byok > subsidy > user > developer", () => {
    expect(FUNDING_PRECEDENCE).toEqual(["byok", "subsidy", "user", "developer"]);
  });

  test("each mode maps to its eligible wallet sources in precedence order", () => {
    expect(eligibleWalletSources("developer")).toEqual(["developer"]);
    expect(eligibleWalletSources("user")).toEqual(["user"]);
    expect(eligibleWalletSources("subsidy")).toEqual(["subsidy"]);
    expect(eligibleWalletSources("byok")).toEqual([]);
    // Hybrid: the user's own funds first, developer funds as backstop.
    expect(eligibleWalletSources("hybrid")).toEqual(["user", "developer"]);
  });

  test("every mode's source list is a subsequence of the frozen precedence", () => {
    for (const mode of FUNDING_MODES) {
      const sources = eligibleWalletSources(mode);
      let cursor = 0;
      for (const source of sources) {
        const index = FUNDING_PRECEDENCE.indexOf(source);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index, `${mode}: ${source} out of precedence order`).toBeGreaterThan(cursor - 1);
        expect(index).toBeGreaterThanOrEqual(cursor);
        cursor = index + 1;
      }
    }
  });

  test("user/hybrid modes require an end-user identity; others do not", () => {
    expect(modeRequiresUser("user")).toBe(true);
    expect(modeRequiresUser("hybrid")).toBe(true);
    expect(modeRequiresUser("developer")).toBe(false);
    expect(modeRequiresUser("byok")).toBe(false);
    expect(modeRequiresUser("subsidy")).toBe(false);
  });

  test("budget evaluation precedence is frozen: per-execution -> monthly -> user-monthly", () => {
    expect(BUDGET_CHECK_ORDER).toEqual(["per-execution", "monthly", "user-monthly"]);
  });
});
