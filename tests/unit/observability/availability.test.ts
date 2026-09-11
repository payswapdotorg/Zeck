/**
 * Unit tests — the control-plane availability measurement (WORK-060 /
 * D-08, AVA-001).
 *
 * Proves the computation: the honest availability number (served time /
 * total time), the fail-closed semantics classification (a
 * refused-to-serve interval against a dead authority is CORRECT
 * behavior — NOT counted as serving, NOT a violation; a
 * served-against-dead-authority interval violates the semantics), the
 * target evaluation (99.9 production-class threshold), the alert-state
 * integration (critical below target / on violation; warning in the
 * near-breach margin), the deterministic evidence digest
 * (IDENTITY-IDEMPOTENCY), the readiness-outcome derivation (the D-01/
 * D-06 control-plane availability fact), and the fail-closed input
 * validation (unordered/overlapping/empty/malformed inputs refuse).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadQuotaGuardsPolicy } from "../../../src/platform/observability/alerts";
import {
  AVAILABILITY_OUTCOMES,
  AvailabilityComputationError,
  type AvailabilityInterval,
  availabilityAlertOf,
  availabilityOutcomeOfReadiness,
  computeAvailabilityWindow,
} from "../../../src/platform/observability/availability";
import { ALERT_KINDS } from "../../../src/platform/observability/port";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function readQuotaGuardsSource(): string {
  return readFileSync(join(REPO_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8");
}

const REVISION = {
  releaseId: "a".repeat(64),
  gitRevision: "f".repeat(40),
  manifestDigest: "0".repeat(64),
};

function interval(
  startedAt: string,
  endedAt: string,
  outcome: AvailabilityInterval["outcome"],
): AvailabilityInterval {
  return { startedAt, endedAt, outcome };
}

describe("the outcome vocabulary and the readiness derivation (AVA-001)", () => {
  test("the closed outcome vocabulary carries the fail-closed semantics distinction", () => {
    expect(AVAILABILITY_OUTCOMES).toEqual([
      "served",
      "refused-fail-closed",
      "unavailable",
      "served-against-dead-authority",
    ]);
    expect(ALERT_KINDS).toContain("availability");
  });

  test("readiness maps to availability outcomes (the control-plane availability fact)", () => {
    expect(availabilityOutcomeOfReadiness("ready")).toBe("served");
    expect(availabilityOutcomeOfReadiness("degraded")).toBe("served");
    expect(availabilityOutcomeOfReadiness("down")).toBe("refused-fail-closed");
    expect(availabilityOutcomeOfReadiness("unavailable")).toBe("unavailable");
  });
});

describe("the monthly window computation (pure, deterministic)", () => {
  const DAY = 86_400_000;

  test("the honest availability number: served / total; refused-fail-closed is NOT counted as serving", () => {
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision: REVISION,
      intervals: [
        interval("2026-09-01T00:00:00Z", "2026-09-29T00:00:00Z", "served"),
        interval("2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z", "refused-fail-closed"),
      ],
      targetPct: 99.9,
    });
    expect(record.totalMs).toBe(29 * DAY);
    expect(record.servedMs).toBe(28 * DAY);
    expect(record.refusedFailClosedMs).toBe(DAY);
    expect(record.availabilityPct).toBeCloseTo((28 / 29) * 100, 3);
    expect(record.withinTarget).toBe(false);
    expect(record.failClosedSemantics).toBe("preserved");
    expect(record.intervalCount).toBe(2);
  });

  test("a 99.9% window passes the production threshold exactly (three nines is the floor)", () => {
    // 43.2 minutes of a 30-day window = 0.1% — the exact monthly error budget.
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision: REVISION,
      intervals: [
        interval("2026-09-01T00:00:00Z", "2026-09-30T23:16:48Z", "served"),
        interval("2026-09-30T23:16:48Z", "2026-10-01T00:00:00Z", "refused-fail-closed"),
      ],
      targetPct: 99.9,
    });
    expect(record.availabilityPct).toBe(99.9);
    expect(record.withinTarget).toBe(true);
    expect(record.failClosedSemantics).toBe("preserved");
    // Exactly at the target floor is WITHIN target but inside the
    // near-breach margin — the alert-before-breach doctrine raises a
    // warning (no margin left).
    const alert = availabilityAlertOf(record);
    expect(alert?.severity).toBe("warning");
  });

  test("fail-closed refusals are CORRECT behavior — the semantics stay preserved under authority loss", () => {
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision: REVISION,
      intervals: [
        interval("2026-09-01T00:00:00Z", "2026-09-28T00:00:00Z", "served"),
        interval("2026-09-28T00:00:00Z", "2026-09-30T00:00:00Z", "refused-fail-closed"),
      ],
      targetPct: 99.9,
    });
    // The availability number drops honestly (below target)...
    expect(record.withinTarget).toBe(false);
    // ...but the fail-closed semantics are PRESERVED (the refusal was
    // correct behavior, never a violation).
    expect(record.failClosedSemantics).toBe("preserved");
  });

  test("served-against-dead-authority VIOLATES the semantics (worse than an SLO breach)", () => {
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision: REVISION,
      intervals: [
        interval("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z", "served"),
        interval("2026-09-30T00:00:00Z", "2026-09-30T00:01:00Z", "served-against-dead-authority"),
      ],
      targetPct: 99.9,
    });
    expect(record.failClosedSemantics).toBe("violated");
    expect(record.servedAgainstDeadAuthorityMs).toBe(60_000);
    // The availability number counts it as serving time (honest totals)
    // but the semantics verdict is the violation — the alert says so.
    const alert = availabilityAlertOf(record);
    expect(alert?.severity).toBe("critical");
    expect(alert?.detail).toContain("SERVING against a dead authority");
    expect(alert?.action).toContain("correctness incident");
  });

  test("IDENTITY-IDEMPOTENCY: the evidence digest is deterministic over the identical input set", () => {
    const input = {
      environment: "staging",
      window: "2026-09",
      revision: REVISION,
      intervals: [
        interval("2026-09-01T00:00:00Z", "2026-09-15T00:00:00Z", "served"),
        interval("2026-09-15T00:00:00Z", "2026-09-15T01:00:00Z", "unavailable"),
      ],
      targetPct: 99.5,
    };
    const first = computeAvailabilityWindow(input);
    const second = computeAvailabilityWindow(input);
    expect(second.evidenceDigest).toBe(first.evidenceDigest);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // A different target/window/revision changes the digest (the digest
    // covers the exact identity — RELEASE-IDENTITY).
    const other = computeAvailabilityWindow({ ...input, targetPct: 99.6 });
    expect(other.evidenceDigest).not.toBe(first.evidenceDigest);
    const otherRevision = computeAvailabilityWindow({
      ...input,
      revision: { ...REVISION, gitRevision: "0".repeat(40) },
    });
    expect(otherRevision.evidenceDigest).not.toBe(first.evidenceDigest);
  });

  test("malformed inputs refuse (fail closed — incomplete evidence is never a PASS)", () => {
    const base = {
      environment: "production",
      window: "2026-09",
      revision: REVISION,
      intervals: [interval("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", "served")],
      targetPct: 99.9,
    };
    expect(() => computeAvailabilityWindow({ ...base, window: "2026-9" })).toThrow(
      AvailabilityComputationError,
    );
    expect(() => computeAvailabilityWindow({ ...base, window: "2026-13" })).toThrow(/YYYY-MM/);
    expect(() => computeAvailabilityWindow({ ...base, targetPct: 0 })).toThrow(/percentage/);
    expect(() => computeAvailabilityWindow({ ...base, intervals: [] })).toThrow(
      /at least one observation interval/,
    );
    expect(() =>
      computeAvailabilityWindow({
        ...base,
        intervals: [interval("2026-09-02T00:00:00Z", "2026-09-01T00:00:00Z", "served")],
      }),
    ).toThrow(/non-positive duration/);
    expect(() =>
      computeAvailabilityWindow({
        ...base,
        intervals: [
          interval("2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z", "served"),
          interval("2026-09-02T00:00:00Z", "2026-09-04T00:00:00Z", "served"),
        ],
      }),
    ).toThrow(/non-overlapping/);
    expect(() =>
      computeAvailabilityWindow({
        ...base,
        intervals: [interval("not-a-date", "2026-09-02T00:00:00Z", "served")],
      }),
    ).toThrow(/ISO-8601/);
  });
});

describe("the alert-state integration (the D-06 alert plane)", () => {
  test("a below-target window raises a CRITICAL availability alert that names the honest numbers", () => {
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision: REVISION,
      intervals: [
        interval("2026-09-01T00:00:00Z", "2026-09-29T00:00:00Z", "served"),
        interval("2026-09-29T00:00:00Z", "2026-09-30T00:00:00Z", "refused-fail-closed"),
      ],
      targetPct: 99.9,
    });
    const alert = availabilityAlertOf(record);
    expect(alert?.kind).toBe("availability");
    expect(alert?.severity).toBe("critical");
    expect(alert?.subject).toContain("control-plane-availability@production:2026-09");
    expect(alert?.detail).toContain("below the 99.9% target");
    expect(alert?.detail).toContain("were CORRECT behavior, not counted as serving");
    expect(alert?.action).toContain("never met by weakening");
  });

  test("a near-breach window raises a WARNING (observable before breach)", () => {
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision: REVISION,
      intervals: [
        interval("2026-09-01T00:00:00Z", "2026-09-30T23:38:24Z", "served"),
        interval("2026-09-30T23:38:24Z", "2026-10-01T00:00:00Z", "unavailable"),
      ],
      targetPct: 99.9,
    });
    expect(record.availabilityPct).toBe(99.95);
    const alert = availabilityAlertOf(record);
    expect(alert?.severity).toBe("warning");
    expect(alert?.detail).toContain("approaching breach");
  });

  test("a healthy window raises no alert", () => {
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision: REVISION,
      intervals: [interval("2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z", "served")],
      targetPct: 99.0,
    });
    expect(availabilityAlertOf(record)).toBeNull();
  });
});

describe("the repository availability targets (the 99.9 production wiring)", () => {
  test("the real quota-guards policy pins production at 99.9 with all four environment classes", () => {
    const policy = loadQuotaGuardsPolicy(readQuotaGuardsSource());
    expect(policy.availabilityTargets.map((target) => target.environment).sort()).toEqual([
      "local",
      "preview",
      "production",
      "staging",
    ]);
    expect(
      policy.availabilityTargets.find((target) => target.environment === "production")
        ?.monthlyAvailabilityTargetPct,
    ).toBe(99.9);
  });

  test("a weakened production target (< 99.9) is unrepresentable at the loader", () => {
    const weakened = JSON.stringify({
      guards: { g: { description: "x", warnAtPct: 80, criticalAtPct: 95 } },
      operationalThresholds: [],
      availability: {
        targets: {
          local: { monthlyAvailabilityTargetPct: 99.0 },
          preview: { monthlyAvailabilityTargetPct: 99.0 },
          staging: { monthlyAvailabilityTargetPct: 99.5 },
          production: { monthlyAvailabilityTargetPct: 99.0 },
        },
      },
    });
    expect(() => loadQuotaGuardsPolicy(weakened)).toThrow(/production availability target must be/);
  });

  test("a missing availability block or a missing environment is unrepresentable", () => {
    expect(() =>
      loadQuotaGuardsPolicy(JSON.stringify({ guards: {}, operationalThresholds: [] })),
    ).toThrow(/availability must be an object/);
    expect(() =>
      loadQuotaGuardsPolicy(
        JSON.stringify({
          guards: {},
          operationalThresholds: [],
          availability: { targets: { local: { monthlyAvailabilityTargetPct: 99.0 } } },
        }),
      ),
    ).toThrow(/must declare "preview"/);
  });
});
