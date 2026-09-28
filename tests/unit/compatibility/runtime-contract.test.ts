/**
 * PPR-018A — the pinned-application runtime contract tests (scope item
 * 1 + the "exact revision binding" battery requirement).
 *
 * Pins the fail-closed exactness law the harness enforces:
 *  - a runtime binding requires BOTH exact revision pins + the
 *    application id (structure validated fail-closed);
 *  - a driver/session whose binding does not EXACTLY match the bound
 *    record's binding is a NAMED defect — unpinned application
 *    execution is refused, never best-effort (the impossibility the
 *    work order demands);
 *  - the registry resolves honestly (a miss is a miss) and refuses
 *    invalid/duplicate registrations;
 *  - the run-level outcome vocabulary derives honestly (PASS / NOT-RUN
 *    / BLOCKED / FAIL / BYPASS_DETECTED with the documented
 *    precedence).
 */

import { describe, expect, test } from "vitest";
import {
  createRuntimeRegistry,
  deriveRunOutcome,
  isRunOutcome,
  type PinnedRuntimeDriver,
  type RevisionPin,
  RUN_OUTCOMES,
  type RunOutcome,
  runtimeBindingIssues,
  runtimeBindingMatches,
  runtimeBindingOf,
  validateRuntimeBinding,
} from "../../../src/integrations/compatibility/public";

const PIN_A: RevisionPin = {
  upstreamRevision: "a".repeat(40),
  integrationRevision: "b".repeat(40),
};
const PIN_B: RevisionPin = {
  upstreamRevision: "c".repeat(40),
  integrationRevision: "d".repeat(40),
};

describe("the runtime binding contract (exact revision binding)", () => {
  test("a runtime binding requires the application id AND both pins (fail-closed structure)", () => {
    expect(validateRuntimeBinding({})).not.toEqual([]);
    expect(
      validateRuntimeBinding({ applicationId: "app", pin: { upstreamRevision: "x" } }),
    ).not.toEqual([]);
    expect(
      validateRuntimeBinding({
        applicationId: "app",
        pin: { upstreamRevision: "x", integrationRevision: "y" },
      }),
    ).toEqual([]);
  });

  test("an EXACT match produces no issues", () => {
    const binding = runtimeBindingOf({
      identity: { name: "App", repository: "https://example.invalid/app", applicationId: "app-1" },
      pin: PIN_A,
    });
    expect(runtimeBindingIssues(binding, { applicationId: "app-1", pin: PIN_A })).toEqual([]);
    expect(runtimeBindingMatches(binding, { applicationId: "app-1", pin: PIN_A })).toBe(true);
  });

  test("IMPOSSIBILITY (unpinned execution): a different upstream revision is a named defect", () => {
    const issues = runtimeBindingIssues(
      { applicationId: "app-1", pin: PIN_A },
      { applicationId: "app-1", pin: { ...PIN_A, upstreamRevision: "e".repeat(40) } },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("runtimeBinding.pin");
    expect(issues[0]?.issue).toContain("unpinned application execution is refused");
    expect(
      runtimeBindingMatches(
        { applicationId: "app-1", pin: PIN_A },
        { applicationId: "app-1", pin: { ...PIN_A, upstreamRevision: "e".repeat(40) } },
      ),
    ).toBe(false);
  });

  test("IMPOSSIBILITY (unpinned execution): a different integration revision is a named defect", () => {
    const issues = runtimeBindingIssues(
      { applicationId: "app-1", pin: PIN_A },
      { applicationId: "app-1", pin: { ...PIN_A, integrationRevision: "f".repeat(40) } },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.issue).toContain("unpinned application execution is refused");
  });

  test("a different application id is a named defect too (both are checked)", () => {
    const issues = runtimeBindingIssues(
      { applicationId: "app-1", pin: PIN_A },
      { applicationId: "app-2", pin: PIN_A },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("runtimeBinding.applicationId");
    // Both defects name themselves together when both mismatch.
    const both = runtimeBindingIssues(
      { applicationId: "app-1", pin: PIN_A },
      { applicationId: "app-2", pin: PIN_B },
    );
    expect(both).toHaveLength(2);
  });
});

describe("the pinned-runtime registry (honest resolution, fail-closed registration)", () => {
  const driver: PinnedRuntimeDriver = {
    runtimeId: "compat/test-app",
    identity: {
      name: "Test application",
      repository: "https://example.invalid/test-app",
      applicationId: "app-1",
    },
    pin: PIN_A,
    start: async () => {
      throw new Error("not started in the registry tests");
    },
  };

  test("a valid driver registers and resolves by its runtime id", () => {
    const registry = createRuntimeRegistry({ drivers: [driver] });
    expect(registry.resolve("compat/test-app")).toBe(driver);
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.upstreamRevision).toBe(PIN_A.upstreamRevision);
  });

  test("an unregistered runtime id resolves to null (an honest miss, never a fallback)", () => {
    const registry = createRuntimeRegistry();
    expect(registry.resolve("compat/no-such-runtime")).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  test("an invalid registration is a NAMED issue, never silently registered", () => {
    const registry = createRuntimeRegistry();
    const issues = registry.register({
      ...driver,
      identity: { ...driver.identity, applicationId: "" },
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(registry.resolve("compat/test-app")).toBeNull();
  });

  test("a duplicate runtime id is a named issue (one runtime per id)", () => {
    const registry = createRuntimeRegistry({ drivers: [driver] });
    const issues = registry.register({ ...driver });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.issue).toContain("already registered");
  });
});

describe("the run-level outcome derivation (the completeness vocabulary)", () => {
  test("the vocabulary is exactly the five run outcomes", () => {
    expect(RUN_OUTCOMES).toEqual(["PASS", "NOT-RUN", "BLOCKED", "FAIL", "BYPASS_DETECTED"]);
    expect(isRunOutcome("PASS")).toBe(true);
    expect(isRunOutcome("COMPLETE")).toBe(false);
  });

  test("a bypass observation overrides everything (a bypassed run is never PASS/FAIL)", () => {
    const outcome: RunOutcome = deriveRunOutcome({ succeeded: true, bypassObserved: true });
    expect(outcome).toBe("BYPASS_DETECTED");
  });

  test("a declared unavailability wins over success (never quietly PASS)", () => {
    expect(
      deriveRunOutcome({
        succeeded: true,
        bypassObserved: false,
        unavailable: { outcome: "NOT-RUN", cause: "credentials unavailable", owner: "provider" },
      }),
    ).toBe("NOT-RUN");
    expect(
      deriveRunOutcome({
        succeeded: null,
        bypassObserved: false,
        unavailable: { outcome: "BLOCKED", cause: "no rail", owner: "provider" },
      }),
    ).toBe("BLOCKED");
  });

  test("the task's own success check decides PASS vs FAIL; no fact means NOT-RUN", () => {
    expect(deriveRunOutcome({ succeeded: true, bypassObserved: false })).toBe("PASS");
    expect(deriveRunOutcome({ succeeded: false, bypassObserved: false })).toBe("FAIL");
    expect(deriveRunOutcome({ succeeded: null, bypassObserved: false })).toBe("NOT-RUN");
  });
});
