/**
 * Unit tests — the provider quota/spend fence (DEP-001 AC5: "Quota
 * exhaustion and provider outage fail safely without silent paid
 * overage").
 *
 * Mock-verified negative paths over the REAL manifest provider map:
 *  - usage under the warn threshold → allow;
 *  - usage at the warn threshold → warn (the operational alert posture);
 *  - usage at/over the limit → DENY (quota-exhausted) with the
 *    provider's declared degradation mode and effect — the default
 *    fail-closed policy NEVER continues paid consumption;
 *  - the default overage policy is fail-closed: no silent paid
 *    overage is representable;
 *  - continuing past a limit requires an EXPLICIT RECORDED approval
 *    (explicit-opt-in), is bounded by the approved overage amount and
 *    carries the approval identity in the decision;
 *  - unknown usage (provider outage / probe failure) → deny
 *    fail-closed — never a permissive default on missing telemetry;
 *  - provider outage postures: authoritative → fail-closed,
 *    non-authoritative → the declared degraded mode, and the
 *    authority role is preserved (never promoted) by construction;
 *  - an undeclared concern or a non-positive limit fails closed with
 *    a thrown error (unrepresentable input).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import {
  evaluateQuotaFence,
  type OverageApproval,
  providerOutagePosture,
} from "../../../src/platform/deployment/quota-fence";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

const manifest = loadReal();

const approval: OverageApproval = {
  approvedBy: "release-operator",
  approvedAt: "2026-09-16T00:00:00Z",
  overageAmount: 5,
};

describe("the quota fence decision ladder (AC5)", () => {
  test("usage under the warn threshold allows", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "artifact-bytes", metric: "storage", used: 4, limit: 10 },
    });
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.denyReason).toBeUndefined();
    expect(evaluation.authorityRole).toBe("non-authoritative");
  });

  test("usage at the warn threshold warns (the operational alert posture)", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "artifact-bytes", metric: "storage", used: 8, limit: 10 },
    });
    expect(evaluation.decision).toBe("warn");
    expect(evaluation.degradedMode).toBe("artifact-store-unavailable");
  });

  test("usage at the limit denies fail-closed with the declared degradation", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "artifact-bytes", metric: "storage", used: 10, limit: 10 },
    });
    expect(evaluation.decision).toBe("deny");
    expect(evaluation.denyReason).toBe("quota-exhausted");
    expect(evaluation.degradedMode).toBe("artifact-store-unavailable");
    expect(evaluation.degradationEffect).toContain(
      "Operations requiring artifact bytes fail explicitly",
    );
    expect(evaluation.detail).toContain("no silent paid overage");
  });

  test("usage over the limit denies the same way", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: {
        concern: "ephemeral-coordination",
        metric: "commands",
        used: 12_000,
        limit: 10_000,
      },
    });
    expect(evaluation.decision).toBe("deny");
    expect(evaluation.denyReason).toBe("quota-exhausted");
    expect(evaluation.degradedMode).toBe("coordination-degraded");
  });

  test("exhaustion of the AUTHORITATIVE concern denies with the fail-closed authority posture", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "relational-state", metric: "storage", used: 0.6, limit: 0.5 },
    });
    expect(evaluation.decision).toBe("deny");
    expect(evaluation.authorityRole).toBe("authoritative");
    expect(evaluation.degradationEffect).toContain("refuse");
    expect(evaluation.degradationEffect).toContain("No datastore is silently promoted");
  });
});

describe("silent paid overage is unrepresentable (AC5)", () => {
  test("the default overage policy is fail-closed (deny at the limit)", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "artifact-bytes", metric: "storage", used: 10, limit: 10 },
    });
    expect(evaluation.decision).toBe("deny");
    expect(evaluation.overageApproval).toBeUndefined();
  });

  test("explicit-opt-in without a recorded approval still denies", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "artifact-bytes", metric: "storage", used: 10, limit: 10 },
      overagePolicy: "explicit-opt-in",
    });
    expect(evaluation.decision).toBe("deny");
    expect(evaluation.denyReason).toBe("overage-not-approved");
    expect(evaluation.detail).toContain("silent paid overage is unrepresentable");
  });

  test("an explicit recorded approval allows a bounded continuation and is carried in the decision", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "artifact-bytes", metric: "storage", used: 11, limit: 10 },
      overagePolicy: "explicit-opt-in",
      overageApproval: approval,
    });
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.overageApproval).toEqual(approval);
    expect(evaluation.detail).toContain("release-operator");
  });

  test("the approved overage bound is enforced (deny at limit + overage)", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "artifact-bytes", metric: "storage", used: 15, limit: 10 },
      overagePolicy: "explicit-opt-in",
      overageApproval: approval,
    });
    expect(evaluation.decision).toBe("deny");
    expect(evaluation.denyReason).toBe("quota-exhausted");
    expect(evaluation.overageApproval).toEqual(approval);
  });

  test("a non-positive overage approval amount fails closed", () => {
    expect(() =>
      evaluateQuotaFence(manifest, {
        snapshot: { concern: "artifact-bytes", metric: "storage", used: 11, limit: 10 },
        overagePolicy: "explicit-opt-in",
        overageApproval: { ...approval, overageAmount: 0 },
      }),
    ).toThrow("non-positive overage amount");
  });
});

describe("unknown usage fails closed (the outage probe path)", () => {
  test("null usage denies with usage-unknown — never a permissive default", () => {
    const evaluation = evaluateQuotaFence(manifest, {
      snapshot: { concern: "relational-state", metric: "storage", used: null, limit: 1 },
    });
    expect(evaluation.decision).toBe("deny");
    expect(evaluation.denyReason).toBe("usage-unknown");
    expect(evaluation.detail).toContain("spend-incurring operations are denied fail-closed");
  });

  test("non-finite usage fails closed with a thrown error", () => {
    expect(() =>
      evaluateQuotaFence(manifest, {
        snapshot: { concern: "relational-state", metric: "storage", used: Number.NaN, limit: 1 },
      }),
    ).toThrow("non-finite/negative usage");
  });
});

describe("unrepresentable inputs fail closed", () => {
  test("an undeclared concern is rejected", () => {
    expect(() =>
      evaluateQuotaFence(manifest, {
        snapshot: { concern: "mystery-concern", metric: "x", used: 1, limit: 2 },
      }),
    ).toThrow('concern "mystery-concern" has no declared provider');
  });

  test("a non-positive limit is rejected", () => {
    expect(() =>
      evaluateQuotaFence(manifest, {
        snapshot: { concern: "artifact-bytes", metric: "storage", used: 1, limit: 0 },
      }),
    ).toThrow("non-positive limit");
  });
});

describe("provider outage postures (degraded-but-alive, authority preserved)", () => {
  test("the authoritative relational concern fails closed on outage", () => {
    const posture = providerOutagePosture(manifest, "relational-state");
    expect(posture.onFailure).toBe("fail-closed");
    expect(posture.authorityRole).toBe("authoritative");
    expect(posture.authorityPreserved).toBe(true);
    expect(posture.degradedMode).toBe("authority-unavailable");
  });

  test("a non-authoritative concern degrades explicitly and stays alive", () => {
    const posture = providerOutagePosture(manifest, "async-transport");
    expect(posture.onFailure).toBe("degraded");
    expect(posture.authorityRole).toBe("non-authoritative");
    expect(posture.degradedMode).toBe("dispatch-backlogged");
    expect(posture.effect).toContain("Execution admission continues through PostgreSQL authority");
  });

  test("an outage posture for an undeclared concern fails closed", () => {
    expect(() => providerOutagePosture(manifest, "mystery-concern")).toThrow(
      'concern "mystery-concern" has no declared provider',
    );
  });

  test("every declared concern's outage posture preserves its manifest authority role", () => {
    for (const provider of manifest.providers) {
      const posture = providerOutagePosture(manifest, provider.concern);
      expect(posture.authorityRole).toBe(provider.degradation.authority);
      expect(posture.authorityPreserved).toBe(true);
    }
  });
});
