/**
 * Unit — alert evaluation + the quota-guards policy loader (WORK-047 /
 * D-06; COST-QUOTA-GUARDS: observable BEFORE exhaustion, actionable,
 * fail-closed on weakening).
 */

import { describe, expect, test } from "vitest";
import {
  DEFAULT_QUOTA_THRESHOLDS,
  evaluateOperationalAlerts,
  evaluateQuotaAlerts,
  hasCriticalAlert,
  loadQuotaGuardsPolicy,
} from "../../../src/platform/observability/alerts";

describe("quota alert evaluation (WORK-047 D-06)", () => {
  const policy = {
    guards: {
      "compute-claims": { warnAtPct: 80, criticalAtPct: 95 },
      "queue-backlog": { warnAtPct: 80, criticalAtPct: 95 },
    },
  };

  test("below the warning threshold: no alert (quiet operation)", () => {
    const alerts = evaluateQuotaAlerts(
      [{ guard: "compute-claims", environment: "local", used: 5, limit: 8 }],
      policy,
    );
    expect(alerts).toHaveLength(0);
  });

  test("the warning fires BEFORE exhaustion (the free-tier doctrine)", () => {
    const alerts = evaluateQuotaAlerts(
      [{ guard: "compute-claims", environment: "local", used: 7, limit: 8 }],
      policy,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("quota-warning");
    expect(alerts[0]?.severity).toBe("warning");
    expect(alerts[0]?.action).toContain("raise the quota");
  });

  test("the critical fires at the exhaustion edge and wins over warning", () => {
    const alerts = evaluateQuotaAlerts(
      [{ guard: "compute-claims", environment: "local", used: 8, limit: 8 }],
      policy,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.kind).toBe("quota-critical");
    expect(alerts[0]?.severity).toBe("critical");
    expect(hasCriticalAlert(alerts)).toBe(true);
  });

  test("unknown guards fall back to the repository default thresholds", () => {
    const alerts = evaluateQuotaAlerts(
      [
        {
          guard: "unlisted-guard",
          environment: "local",
          used: DEFAULT_QUOTA_THRESHOLDS.criticalAtPct,
          limit: 100,
        },
      ],
      { guards: {} },
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.severity).toBe("critical");
  });

  test("limit <= 0 is treated as exhausted (fail closed, never divided by zero)", () => {
    const alerts = evaluateQuotaAlerts(
      [{ guard: "compute-claims", environment: "local", used: 1, limit: 0 }],
      policy,
    );
    expect(alerts[0]?.severity).toBe("critical");
  });
});

describe("operational alert evaluation (error monitoring)", () => {
  const thresholds = [
    {
      metric: "queue-dead-letters",
      window: "total",
      warnAbove: 10,
      criticalAbove: 100,
      action: "inspect dead letters",
    },
  ];

  test("quiet below the bounds", () => {
    expect(
      evaluateOperationalAlerts(
        [{ metric: "queue-dead-letters", window: "total", value: 3 }],
        thresholds,
      ),
    ).toHaveLength(0);
  });

  test("warning and critical bounds fire with the actionable guidance attached", () => {
    const warning = evaluateOperationalAlerts(
      [{ metric: "queue-dead-letters", window: "total", value: 11 }],
      thresholds,
    );
    expect(warning[0]?.kind).toBe("error-rate");
    expect(warning[0]?.severity).toBe("warning");
    expect(warning[0]?.action).toBe("inspect dead letters");
    const critical = evaluateOperationalAlerts(
      [{ metric: "queue-dead-letters", window: "total", value: 101 }],
      thresholds,
    );
    expect(critical[0]?.severity).toBe("critical");
  });

  test("metrics without a declared threshold are ignored (closed policy)", () => {
    expect(
      evaluateOperationalAlerts(
        [{ metric: "unknown-metric", window: "total", value: 9999 }],
        thresholds,
      ),
    ).toHaveLength(0);
  });
});

describe("the quota-guards policy loader (fail closed on weakening)", () => {
  const repositorySource = JSON.stringify({
    guards: {
      "compute-claims": {
        description: "live claims vs quota",
        warnAtPct: 80,
        criticalAtPct: 95,
      },
    },
    operationalThresholds: [
      {
        metric: "queue-dead-letters",
        window: "total",
        warnAbove: 10,
        criticalAbove: 100,
        action: "inspect",
      },
    ],
  });

  test("the repository-shape policy loads", () => {
    const policy = loadQuotaGuardsPolicy(repositorySource);
    expect(policy.guards).toHaveLength(1);
    expect(policy.guards[0]?.thresholds.criticalAtPct).toBe(95);
    expect(policy.operationalThresholds).toHaveLength(1);
  });

  test("the weakening mutation — a missing critical threshold — is rejected", () => {
    const weakened = JSON.stringify({
      guards: { "compute-claims": { description: "x", warnAtPct: 80 } },
      operationalThresholds: [],
    });
    expect(() => loadQuotaGuardsPolicy(weakened)).toThrow(/warnAtPct and criticalAtPct/);
  });

  test("the unbounded mutation — critical at 100000 — is rejected", () => {
    const unbounded = JSON.stringify({
      guards: { "compute-claims": { description: "x", warnAtPct: 80, criticalAtPct: 100000 } },
      operationalThresholds: [],
    });
    expect(() => loadQuotaGuardsPolicy(unbounded)).toThrow(/ordered percentages/);
  });

  test("inverted thresholds (warn >= critical) are rejected", () => {
    const inverted = JSON.stringify({
      guards: { g: { description: "x", warnAtPct: 95, criticalAtPct: 80 } },
      operationalThresholds: [],
    });
    expect(() => loadQuotaGuardsPolicy(inverted)).toThrow(/ordered percentages/);
  });

  test("an alert without an action is rejected (alerts are actionable)", () => {
    const actionless = JSON.stringify({
      guards: {},
      operationalThresholds: [{ metric: "m", window: "total", warnAbove: 1, criticalAbove: 2 }],
    });
    expect(() => loadQuotaGuardsPolicy(actionless)).toThrow(/action must be a non-empty string/);
  });
});
