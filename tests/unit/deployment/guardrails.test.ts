/**
 * Unit tests — the deploy-surface spend/quota guardrail composition
 * (DEP-003 AC3: "Quota/spend guardrail negative paths are tested:
 * ceiling refusal, alert threshold, no silent overage; thresholds
 * come from the manifests").
 *
 * Proves over the REAL repository manifests (quota-guards.json +
 * providers.json + the deployment manifest — loaded, never re-declared
 * in the test):
 *
 *  - LIMIT RESOLUTION: the manifest is the only limit carrier —
 *    operator override > manifest defaultLimitBytes row >
 *    authority-owned (null); a MALFORMED operator override ABORTS
 *    fail-closed (never a silent substitution);
 *  - CEILING REFUSAL: a provider-concern usage snapshot at/over its
 *    declared limit denies with the provider's declared degradation
 *    mode (the governed refusal — authoritative fails closed,
 *    non-authoritative degrades explicitly);
 *  - ALERT THRESHOLDS FIRE PER quota-guards.json: warnings at the
 *    manifest warnAtPct, criticals at the manifest criticalAtPct, and
 *    a MUTATED manifest row changes the evaluation (thresholds are
 *    never tool-local constants);
 *  - NO SILENT PAID OVERAGE: at the limit the fence denies
 *    (overage-not-approved under explicit-opt-in without an approval;
 *    fail-closed by default); continuing past the limit requires an
 *    explicit, recorded, bounded overage approval, and the approved
 *    bound itself denies when reached;
 *  - UNKNOWN USAGE fails closed (never a permissive default);
 *  - the promotion guardrail: a CRITICAL alert blocks promotion (the
 *    D-06 semantics, one alert authority);
 *  - the guard→concern projection maps exactly the two
 *    authoritative-store-metered provider concerns and invents
 *    nothing for compute-claims (authority-owned) or artifact-bytes
 *    (not measurable locally — the honest NOT RUN boundary).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  evaluateEnvironmentGuardrails,
  fenceSnapshotsOf,
  GuardLimitError,
  type GuardrailReport,
  resolveGuardLimit,
} from "../../../deploy/guardrails";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import type { QuotaFenceEvaluation } from "../../../src/platform/deployment/quota-fence";
import { loadQuotaGuardsPolicy } from "../../../src/platform/observability/alerts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadRealPolicy(
  source = readFileSync(join(REPO_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8"),
) {
  return loadQuotaGuardsPolicy(source);
}

const manifest = loadDeploymentManifest((file) =>
  readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
);

const policy = loadRealPolicy();

/** The single fence decision a negative-path scenario projects (fail loudly if absent). */
function fenceOf(report: GuardrailReport): QuotaFenceEvaluation {
  const fence = report.fenceDecisions[0];
  if (fence === undefined) {
    throw new Error("expected exactly one fence decision in the report");
  }
  return fence;
}

describe("guard limit resolution (the manifest is the only limit carrier)", () => {
  test("the manifest defaultLimitBytes row resolves when no override is present", () => {
    const queueBacklog = resolveGuardLimit("queue-backlog", policy);
    expect(queueBacklog.limit).toBe(1000);
    expect(queueBacklog.source).toBe("manifest");
    const databaseSize = resolveGuardLimit("database-size", policy);
    expect(databaseSize.limit).toBe(5_368_709_120);
    expect(databaseSize.source).toBe("manifest");
  });

  test("a well-formed operator override wins over the manifest row (auditable)", () => {
    const resolution = resolveGuardLimit("queue-backlog", policy, "2500");
    expect(resolution.limit).toBe(2500);
    expect(resolution.source).toBe("operator-override");
  });

  test("an absent manifest row with no override is authority-owned (null — nothing invented)", () => {
    const resolution = resolveGuardLimit("compute-claims", policy);
    expect(resolution.limit).toBeNull();
    expect(resolution.source).toBe("authority-owned");
  });

  test("a MALFORMED operator override aborts fail-closed (never a silent substitution)", () => {
    for (const malformed of ["abc", "-5", "0", "1.5", "12abc", "1e3.5"]) {
      expect(() => resolveGuardLimit("queue-backlog", policy, malformed)).toThrow(GuardLimitError);
    }
    // "1e3" is a valid integer literal (1000) — accepted, not truncated
    // to 1 (the parseInt hole the strict parse closes).
    expect(resolveGuardLimit("queue-backlog", policy, "1e3").limit).toBe(1000);
    // The exact honest message names the guard and the malformed value.
    try {
      resolveGuardLimit("database-size", policy, "not-a-number");
      expect.unreachable("the malformed override must abort");
    } catch (error) {
      expect((error as Error).message).toContain("database-size");
      expect((error as Error).message).toContain("not-a-number");
      expect((error as Error).message).toContain("fail closed");
    }
  });

  test("an empty override string falls through to the manifest row (unset, not malformed)", () => {
    const resolution = resolveGuardLimit("queue-backlog", policy, "");
    expect(resolution.limit).toBe(1000);
    expect(resolution.source).toBe("manifest");
  });
});

describe("the guard → provider-concern projection", () => {
  test("projects exactly the two authoritative-store-metered provider concerns", () => {
    const projected = fenceSnapshotsOf(
      [
        { guard: "database-size", environment: "production", used: 100, limit: 1000 },
        { guard: "queue-backlog", environment: "production", used: 10, limit: 100 },
        { guard: "compute-claims", environment: "production", used: 1, limit: 4 },
      ],
      policy,
    );
    expect(projected).toHaveLength(2);
    const byMetric = new Map(projected.map((snapshot) => [snapshot.metric, snapshot]));
    expect(byMetric.get("database-size-bytes")).toEqual({
      concern: "relational-state",
      metric: "database-size-bytes",
      used: 100,
      limit: 1000,
      warnAt: 800, // 80% of 1000 — the manifest warnAtPct of the database-size row
    });
    expect(byMetric.get("pending-dispatch-envelopes")).toEqual({
      concern: "async-transport",
      metric: "pending-dispatch-envelopes",
      used: 10,
      limit: 100,
      warnAt: 80,
    });
    // compute-claims is NOT projected (authority-owned limit; the
    // compute plane's D-05 hard cap is the enforcement, no provider
    // spend to fence) and nothing is invented for artifact-bytes.
    expect(projected.some((snapshot) => snapshot.concern === "execution-compute")).toBe(false);
    expect(projected.some((snapshot) => snapshot.concern === "artifact-bytes")).toBe(false);
  });
});

describe("the composed environment guardrail evaluation (negative paths)", () => {
  test("ceiling refusal: database-size at the limit denies with the declared fail-closed authority posture", () => {
    const report = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "production",
      quotaSnapshots: [
        {
          guard: "database-size",
          environment: "production",
          used: 5_368_709_120,
          limit: 5_368_709_120,
        },
      ],
      fenceSnapshots: [
        {
          concern: "relational-state",
          metric: "database-size-bytes",
          used: 5_368_709_120,
          limit: 5_368_709_120,
          warnAt: 4_294_967_296,
        },
      ],
    });
    expect(report.fenceDecisions).toHaveLength(1);
    const fence = fenceOf(report);
    expect(fence.decision).toBe("deny");
    expect(fence.denyReason).toBe("quota-exhausted");
    expect(fence.concern).toBe("relational-state");
    expect(fence.authorityRole).toBe("authoritative");
    expect(fence.degradedMode).toBe("authority-unavailable");
    expect(fence.degradationEffect).toContain("refuse");
    // The same exhaustion also fires the CRITICAL alert at the
    // manifest criticalAtPct (95 ≤ 100% utilization) — the D-06
    // promotion guardrail blocks.
    expect(report.promotionBlocked).toBe(true);
    expect(report.blockReasons[0]).toContain("database-size@production");
  });

  test("ceiling refusal: queue backlog at the bound denies with the declared degraded mode (non-authoritative)", () => {
    const report = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "staging",
      quotaSnapshots: [{ guard: "queue-backlog", environment: "staging", used: 1000, limit: 1000 }],
      fenceSnapshots: [
        {
          concern: "async-transport",
          metric: "pending-dispatch-envelopes",
          used: 1000,
          limit: 1000,
          warnAt: 800,
        },
      ],
    });
    const fence = fenceOf(report);
    expect(fence.decision).toBe("deny");
    expect(fence.denyReason).toBe("quota-exhausted");
    expect(fence.authorityRole).toBe("non-authoritative");
    expect(fence.degradedMode).toBe("dispatch-backlogged");
    expect(fence.degradationEffect).toContain("never mistaken for execution success");
  });

  test("the alert thresholds fire per quota-guards.json: warning at warnAtPct, critical at criticalAtPct", () => {
    // queue-backlog: warn 80% / critical 95% (the repository row).
    const warn = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "local",
      quotaSnapshots: [{ guard: "queue-backlog", environment: "local", used: 800, limit: 1000 }],
      fenceSnapshots: [],
    });
    expect(warn.alerts).toHaveLength(1);
    expect(warn.alerts[0]?.severity).toBe("warning");
    expect(warn.alerts[0]?.subject).toBe("queue-backlog@local");
    expect(warn.alerts[0]?.action).toContain("plan capacity");
    expect(warn.promotionBlocked).toBe(false);

    const critical = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "local",
      quotaSnapshots: [{ guard: "queue-backlog", environment: "local", used: 950, limit: 1000 }],
      fenceSnapshots: [],
    });
    expect(critical.alerts).toHaveLength(1);
    expect(critical.alerts[0]?.severity).toBe("critical");
    expect(critical.alerts[0]?.kind).toBe("quota-critical");
    expect(critical.promotionBlocked).toBe(true);
  });

  test("thresholds are NOT tool-local constants: a mutated manifest row changes the evaluation", () => {
    // Same utilization (700/1000 = 70%): quiet under the repository
    // row (warn 80%), WARNING under a mutated row (warn 60%) — the
    // manifest is the threshold authority.
    const quiet = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "local",
      quotaSnapshots: [{ guard: "queue-backlog", environment: "local", used: 700, limit: 1000 }],
      fenceSnapshots: [],
    });
    expect(quiet.alerts).toHaveLength(0);

    const mutated = loadRealPolicy(
      JSON.stringify(
        {
          ...JSON.parse(
            readFileSync(join(REPO_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8"),
          ),
          guards: {
            ...JSON.parse(
              readFileSync(join(REPO_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8"),
            ).guards,
            "queue-backlog": {
              description: "mutated row for the threshold-authority proof",
              warnAtPct: 60,
              criticalAtPct: 90,
              defaultLimitBytes: 1000,
            },
          },
        },
        null,
        2,
      ),
    );
    const warning = evaluateEnvironmentGuardrails(manifest, mutated, {
      environment: "local",
      quotaSnapshots: [{ guard: "queue-backlog", environment: "local", used: 700, limit: 1000 }],
      fenceSnapshots: [],
    });
    expect(warning.alerts).toHaveLength(1);
    expect(warning.alerts[0]?.severity).toBe("warning");
    expect(warning.thresholdsApplied["queue-backlog"]).toEqual({
      warnAtPct: 60,
      criticalAtPct: 90,
    });
    // The mutated criticalAtPct (90) also moves the promotion edge.
    const mutatedCritical = evaluateEnvironmentGuardrails(manifest, mutated, {
      environment: "local",
      quotaSnapshots: [{ guard: "queue-backlog", environment: "local", used: 900, limit: 1000 }],
      fenceSnapshots: [],
    });
    expect(mutatedCritical.promotionBlocked).toBe(true);
  });

  test("no silent paid overage: at the limit the default policy denies; explicit-opt-in without an approval denies typed", () => {
    const atLimit = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "production",
      quotaSnapshots: [],
      fenceSnapshots: [
        {
          concern: "relational-state",
          metric: "database-size-bytes",
          used: 5_368_709_120,
          limit: 5_368_709_120,
        },
      ],
    });
    expect(fenceOf(atLimit).decision).toBe("deny");
    expect(fenceOf(atLimit).denyReason).toBe("quota-exhausted");
    expect(fenceOf(atLimit).overageApproval).toBeUndefined();

    const optInNoApproval = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "production",
      quotaSnapshots: [],
      fenceSnapshots: [
        {
          concern: "relational-state",
          metric: "database-size-bytes",
          used: 5_368_709_120,
          limit: 5_368_709_120,
        },
      ],
      overagePolicy: "explicit-opt-in",
    });
    expect(fenceOf(optInNoApproval).decision).toBe("deny");
    expect(fenceOf(optInNoApproval).denyReason).toBe("overage-not-approved");
    expect(fenceOf(optInNoApproval).detail).toContain("silent paid overage");
  });

  test("a recorded overage approval is the only continuation path, bounded by the approved amount", () => {
    const approval = {
      approvedBy: "release-operator",
      approvedAt: "2026-09-17T00:00:00Z",
      overageAmount: 1_073_741_824,
    };
    const within = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "production",
      quotaSnapshots: [],
      fenceSnapshots: [
        {
          concern: "relational-state",
          metric: "database-size-bytes",
          used: 5_368_709_121,
          limit: 5_368_709_120,
        },
      ],
      overagePolicy: "explicit-opt-in",
      overageApprovals: { "relational-state": approval },
    });
    expect(fenceOf(within).decision).toBe("allow");
    expect(fenceOf(within).overageApproval).toEqual(approval);
    expect(fenceOf(within).detail).toContain(approval.approvedBy);

    // The approved bound itself denies when reached (the approval is
    // bounded, not a blank check).
    const exhausted = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "production",
      quotaSnapshots: [],
      fenceSnapshots: [
        {
          concern: "relational-state",
          metric: "database-size-bytes",
          used: 5_368_709_120 + 1_073_741_824,
          limit: 5_368_709_120,
        },
      ],
      overagePolicy: "explicit-opt-in",
      overageApprovals: { "relational-state": approval },
    });
    expect(fenceOf(exhausted).decision).toBe("deny");
    expect(fenceOf(exhausted).denyReason).toBe("quota-exhausted");
  });

  test("unknown usage denies fail-closed (never a permissive default on missing telemetry)", () => {
    const report = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "production",
      quotaSnapshots: [],
      fenceSnapshots: [
        { concern: "relational-state", metric: "database-size-bytes", used: null, limit: 1000 },
      ],
    });
    expect(fenceOf(report).decision).toBe("deny");
    expect(fenceOf(report).denyReason).toBe("usage-unknown");
    expect(fenceOf(report).authorityRole).toBe("authoritative");
  });

  test("the environment class binds the evaluation (alert subjects + report label)", () => {
    const report = evaluateEnvironmentGuardrails(manifest, policy, {
      environment: "staging",
      quotaSnapshots: [{ guard: "queue-backlog", environment: "staging", used: 950, limit: 1000 }],
      fenceSnapshots: [],
    });
    expect(report.environment).toBe("staging");
    expect(report.alerts[0]?.subject).toBe("queue-backlog@staging");
  });
});
