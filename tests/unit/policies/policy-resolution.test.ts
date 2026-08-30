/**
 * Unit: policy domain resolution (WORK-007, POL-001/POL-002/POL-003).
 *
 * Pure-domain proofs over the five-scope precedence, the nine-dimension
 * vocabulary, monotonic tightening (negative at EVERY scope pair),
 * deny documents, determinism and canonical-hash stability.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  AUTONOMY_MODES,
  canonicalPolicyJson,
  checkMonotonicTightening,
  EGRESS_MODES,
  ISOLATION_LEVELS,
  POLICY_DIMENSIONS,
  POLICY_SCOPES,
  type PolicyDocument,
  type PolicySet,
  type RestrictionSet,
  resolvePolicy,
  SECRET_ACCESS_MODES,
  scopeRank,
  tightenRestrictionSets,
  validatePolicySet,
} from "../../../src/modules/policies/public";

const TENANT = "tenant-1";
const APP = "app-1";
const USER = "user-1";
const CTX = {
  tenantId: TENANT,
  applicationId: APP,
  userId: USER,
  taskKind: "summarize",
  executionId: "exec-1",
};

const doc = (
  scope: PolicyDocument["scope"],
  restrictions: RestrictionSet,
  selector: PolicyDocument["selector"] = {},
): PolicyDocument => ({ scope, selector, restrictions });

const platformDoc = (r: RestrictionSet): PolicyDocument => doc("platform", r);
const applicationDoc = (r: RestrictionSet): PolicyDocument =>
  doc("application", r, { tenantId: TENANT, applicationId: APP });
const userDoc = (r: RestrictionSet): PolicyDocument =>
  doc("user", r, { tenantId: TENANT, userId: USER });
const taskDoc = (r: RestrictionSet): PolicyDocument => doc("task", r, { taskKind: "summarize" });
const executionDoc = (r: RestrictionSet): PolicyDocument =>
  doc("execution", r, { executionId: "exec-1" });

const setOf = (...documents: PolicyDocument[]): PolicySet => ({
  id: "default",
  version: 1,
  documents,
});

describe("policy scope precedence (POL-001)", () => {
  test("the five scopes exist in the frozen precedence order", () => {
    expect(POLICY_SCOPES).toEqual(["platform", "application", "user", "task", "execution"]);
    expect(scopeRank("platform")).toBe(0);
    expect(scopeRank("execution")).toBe(4);
  });

  test("every scope contributes its restrictions to the effective fold", () => {
    const set = setOf(
      platformDoc({ cost: { maxCostMicroUsd: "1000" } }),
      applicationDoc({ latency: { maxLatencyMs: 500 } }),
      userDoc({ quality: { minQuality: 0.5 } }),
      taskDoc({ tool: { deniedTools: ["browser"] } }),
      executionDoc({ autonomy: { maxAutonomy: "gated" } }),
    );
    const resolution = resolvePolicy(set, CTX);
    expect(resolution.outcome).toBe("allow");
    if (resolution.outcome !== "allow") return;
    expect(resolution.applied.map((entry) => entry.scope)).toEqual(POLICY_SCOPES);
    expect(resolution.effective).toEqual({
      cost: { maxCostMicroUsd: "1000" },
      latency: { maxLatencyMs: 500 },
      quality: { minQuality: 0.5 },
      tool: { deniedTools: ["browser"] },
      autonomy: { maxAutonomy: "gated" },
    });
  });

  test("missing middle scopes are skipped — the chain stays total and deterministic", () => {
    const set = setOf(platformDoc({ cost: { maxCostMicroUsd: "1000" } }), executionDoc({}));
    // executionDoc with empty restrictions {} still applies but folds to nothing
    const resolution = resolvePolicy(set, CTX);
    expect(resolution.outcome).toBe("allow");
    if (resolution.outcome !== "allow") return;
    expect(resolution.applied.map((entry) => entry.scope)).toEqual(["platform", "execution"]);
  });

  test("resolution is independent of document order", () => {
    const a = setOf(
      platformDoc({ cost: { maxCostMicroUsd: "1000" } }),
      applicationDoc({ cost: { maxCostMicroUsd: "700" } }),
      userDoc({ latency: { maxLatencyMs: 300 } }),
    );
    const b = setOf(...[...a.documents].reverse());
    expect(canonicalPolicyJson(resolvePolicy(a, CTX))).toBe(
      canonicalPolicyJson(resolvePolicy(b, CTX)),
    );
  });

  test("non-matching selectors do not apply (tenant/application/user/task/execution aware)", () => {
    const set = setOf(
      doc(
        "application",
        { cost: { maxCostMicroUsd: "700" } },
        {
          tenantId: "other-tenant",
          applicationId: APP,
        },
      ),
      doc("user", { latency: { maxLatencyMs: 300 } }, { tenantId: TENANT, userId: "other-user" }),
      doc("task", { tool: { deniedTools: ["x"] } }, { taskKind: "other-kind" }),
      doc("execution", { autonomy: { maxAutonomy: "none" } }, { executionId: "other-exec" }),
      platformDoc({ cost: { maxCostMicroUsd: "1000" } }),
    );
    const resolution = resolvePolicy(set, CTX);
    expect(resolution.outcome).toBe("allow");
    if (resolution.outcome !== "allow") return;
    expect(resolution.applied.map((entry) => entry.scope)).toEqual(["platform"]);
    expect(resolution.effective).toEqual({ cost: { maxCostMicroUsd: "1000" } });
  });

  test("a user document may bind to one application only", () => {
    const set = setOf(
      platformDoc({ cost: { maxCostMicroUsd: "1000" } }),
      doc(
        "user",
        { latency: { maxLatencyMs: 300 } },
        {
          tenantId: TENANT,
          userId: USER,
          applicationId: "other-app",
        },
      ),
    );
    const resolution = resolvePolicy(set, CTX);
    expect(resolution.outcome).toBe("allow");
    if (resolution.outcome !== "allow") return;
    expect(resolution.applied.map((entry) => entry.scope)).toEqual(["platform"]);
  });

  test("an absolute deny document denies from any scope with its reason", () => {
    for (const scope of POLICY_SCOPES) {
      const denyDocument: PolicyDocument =
        scope === "platform"
          ? { scope, selector: {}, deny: { reason: `${scope} suspension` } }
          : scope === "application"
            ? {
                scope,
                selector: { tenantId: TENANT, applicationId: APP },
                deny: { reason: `${scope} suspension` },
              }
            : scope === "user"
              ? {
                  scope,
                  selector: { tenantId: TENANT, userId: USER },
                  deny: { reason: `${scope} suspension` },
                }
              : scope === "task"
                ? {
                    scope,
                    selector: { taskKind: "summarize" },
                    deny: { reason: `${scope} suspension` },
                  }
                : {
                    scope,
                    selector: { executionId: "exec-1" },
                    deny: { reason: `${scope} suspension` },
                  };
      const resolution = resolvePolicy(setOf(denyDocument), CTX);
      expect(resolution.outcome).toBe("deny");
      if (resolution.outcome !== "deny") continue;
      expect(resolution.denial).toMatchObject({ kind: "prohibited", scope });
    }
  });
});

describe("restriction vocabulary — all nine dimensions (POL-002)", () => {
  test("the vocabulary covers exactly the nine WORK-007 dimensions", () => {
    expect(POLICY_DIMENSIONS).toEqual([
      "cost",
      "quality",
      "latency",
      "providerModel",
      "tool",
      "network",
      "secrets",
      "autonomy",
      "isolation",
    ]);
    expect(POLICY_DIMENSIONS).toHaveLength(9);
  });

  test("ladders are frozen", () => {
    expect(EGRESS_MODES).toEqual(["none", "allowlist", "open"]);
    expect(SECRET_ACCESS_MODES).toEqual(["none", "allowlist", "all"]);
    expect(AUTONOMY_MODES).toEqual(["none", "gated", "sandboxed", "unconstrained"]);
    expect(ISOLATION_LEVELS).toEqual([
      "none",
      "process",
      "container",
      "microvm",
      "vm",
      "customer-runner",
    ]);
  });

  test("a full nine-dimension restriction set validates and resolves", () => {
    const full: RestrictionSet = {
      cost: { maxCostMicroUsd: "5000" },
      quality: { minQuality: 0.8 },
      latency: { maxLatencyMs: 10000 },
      providerModel: {
        allowedProviders: ["rail-a"],
        deniedProviders: ["rail-x"],
        allowedModels: ["m-1"],
        deniedModels: ["m-2"],
      },
      tool: { allowedTools: ["search"], deniedTools: ["terminal"] },
      network: {
        egress: "allowlist",
        allowedHosts: ["api.example"],
        deniedHosts: ["evil.example"],
      },
      secrets: { access: "allowlist", allowedSecretRefs: ["conn-1"], deniedSecretRefs: ["admin"] },
      autonomy: { maxAutonomy: "sandboxed" },
      isolation: { minIsolation: "container" },
    };
    expect(validatePolicySet(setOf(platformDoc(full)))).toEqual([]);
    const resolution = resolvePolicy(setOf(platformDoc(full)), CTX);
    expect(resolution.outcome).toBe("allow");
    if (resolution.outcome !== "allow") return;
    expect(resolution.effective).toEqual(full);
  });

  test("validation rejects malformed policy data (fail closed)", () => {
    const cases: PolicySet[] = [
      setOf(platformDoc({ cost: { maxCostMicroUsd: "12.5" } })), // float money
      setOf(platformDoc({ cost: { maxCostMicroUsd: "abc" } })), // not a number
      setOf(platformDoc({ quality: { minQuality: 1.5 } })), // out of range
      setOf(platformDoc({ latency: { maxLatencyMs: -1 } })), // negative
      setOf(platformDoc({ network: { egress: "wide-open" as never } })), // off-ladder
      setOf(platformDoc({ autonomy: { maxAutonomy: "wild" as never } })),
      setOf(platformDoc({ isolation: { minIsolation: "mainframe" as never } })),
      setOf(
        platformDoc({
          tool: { allowedTools: ["a"], deniedTools: ["a"] },
        }),
      ), // both allowed and denied
      setOf(platformDoc({ tool: { allowedTools: ["a", "a"] } })), // duplicate
      setOf({ ...platformDoc({}), scope: "application", selector: {} } as PolicyDocument), // missing selector ids
      { id: "default", version: 0, documents: [] }, // bad version
      setOf(platformDoc({ cost: {} }), platformDoc({})), // duplicate subject
    ];
    for (const set of cases) {
      expect(validatePolicySet(set).length, canonicalPolicyJson(set)).toBeGreaterThan(0);
    }
    // Benign shapes must NOT be flagged (no false rejections): an empty
    // restrictions object folds to nothing and is a valid document.
    expect(validatePolicySet(setOf(platformDoc({})))).toEqual([]);
  });
});

describe("monotonic tightening (POL-003)", () => {
  test("a lower scope tightening a higher restriction is accepted and folded", () => {
    const set = setOf(
      platformDoc({ cost: { maxCostMicroUsd: "1000" } }),
      applicationDoc({ cost: { maxCostMicroUsd: "700" } }),
      userDoc({ cost: { maxCostMicroUsd: "500" } }),
    );
    const resolution = resolvePolicy(set, CTX);
    expect(resolution.outcome).toBe("allow");
    if (resolution.outcome !== "allow") return;
    expect(resolution.effective.cost?.maxCostMicroUsd).toBe("500");
  });

  test("NEGATIVE: a weakening attempt at EVERY adjacent scope pair is rejected", () => {
    const pairs: Array<[PolicyDocument, PolicyDocument, string]> = [
      [
        platformDoc({ cost: { maxCostMicroUsd: "500" } }),
        applicationDoc({ cost: { maxCostMicroUsd: "1000" } }),
        "platform→application",
      ],
      [
        applicationDoc({ cost: { maxCostMicroUsd: "500" } }),
        userDoc({ cost: { maxCostMicroUsd: "1000" } }),
        "application→user",
      ],
      [
        userDoc({ cost: { maxCostMicroUsd: "500" } }),
        taskDoc({ cost: { maxCostMicroUsd: "1000" } }),
        "user→task",
      ],
      [
        taskDoc({ cost: { maxCostMicroUsd: "500" } }),
        executionDoc({ cost: { maxCostMicroUsd: "1000" } }),
        "task→execution",
      ],
    ];
    for (const [higher, lower, label] of pairs) {
      const resolution = resolvePolicy(setOf(higher, lower), CTX);
      expect(resolution.outcome, label).toBe("deny");
      if (resolution.outcome !== "deny") continue;
      expect(resolution.denial.kind, label).toBe("weakening");
      if (resolution.denial.kind !== "weakening") continue;
      expect(resolution.denial.weakenings[0]).toMatchObject({
        dimension: "cost",
        field: "maxCostMicroUsd",
      });
    }
  });

  test("NEGATIVE: non-adjacent weakening (platform→user) is rejected too", () => {
    const resolution = resolvePolicy(
      setOf(
        platformDoc({ cost: { maxCostMicroUsd: "500" } }),
        userDoc({ cost: { maxCostMicroUsd: "1000" } }),
      ),
      CTX,
    );
    expect(resolution.outcome).toBe("deny");
  });

  test("NEGATIVE: every field class can be weakened and every weakening is rejected", () => {
    const weakeningFieldCases: Array<[RestrictionSet, RestrictionSet, string]> = [
      [{ cost: { maxCostMicroUsd: "100" } }, { cost: { maxCostMicroUsd: "200" } }, "cost ceiling"],
      [{ quality: { minQuality: 0.9 } }, { quality: { minQuality: 0.2 } }, "quality floor"],
      [{ latency: { maxLatencyMs: 100 } }, { latency: { maxLatencyMs: 500 } }, "latency ceiling"],
      [
        { providerModel: { allowedProviders: ["a"] } },
        { providerModel: { allowedProviders: ["a", "b"] } },
        "provider allowlist",
      ],
      [
        { providerModel: { deniedProviders: ["a", "b"] } },
        { providerModel: { deniedProviders: ["a"] } },
        "provider denylist",
      ],
      [
        { tool: { allowedTools: ["t1"] } },
        { tool: { allowedTools: ["t1", "t2"] } },
        "tool allowlist",
      ],
      [{ tool: { deniedTools: ["t1", "t2"] } }, { tool: { deniedTools: ["t1"] } }, "tool denylist"],
      [{ network: { egress: "none" } }, { network: { egress: "open" } }, "egress ladder"],
      [
        { network: { allowedHosts: ["h1"] } },
        { network: { allowedHosts: ["h1", "h2"] } },
        "host allowlist",
      ],
      [{ secrets: { access: "none" } }, { secrets: { access: "all" } }, "secret access ladder"],
      [
        { secrets: { allowedSecretRefs: ["s1"] } },
        { secrets: { allowedSecretRefs: ["s1", "s2"] } },
        "secret allowlist",
      ],
      [
        { secrets: { deniedSecretRefs: ["s1", "s2"] } },
        { secrets: { deniedSecretRefs: ["s1"] } },
        "secret denylist",
      ],
      [
        { autonomy: { maxAutonomy: "none" } },
        { autonomy: { maxAutonomy: "unconstrained" } },
        "autonomy ladder",
      ],
      [
        { isolation: { minIsolation: "vm" } },
        { isolation: { minIsolation: "process" } },
        "isolation ladder",
      ],
      [
        { providerModel: { allowedModels: ["m1"] } },
        { providerModel: { allowedModels: ["m1", "m2"] } },
        "model allowlist",
      ],
      [
        { providerModel: { deniedModels: ["m1", "m2"] } },
        { providerModel: { deniedModels: ["m1"] } },
        "model denylist",
      ],
    ];
    for (const [higher, lower, label] of weakeningFieldCases) {
      const check = checkMonotonicTightening(lower, higher);
      expect(check.ok, label).toBe(false);
      expect(check.weakenings.length, label).toBeGreaterThan(0);

      const resolution = resolvePolicy(setOf(platformDoc(higher), applicationDoc(lower)), CTX);
      expect(resolution.outcome, label).toBe("deny");
    }
  });

  test("equal values and absent higher fields are neutral (no false rejections)", () => {
    expect(
      checkMonotonicTightening(
        { cost: { maxCostMicroUsd: "500" } },
        { cost: { maxCostMicroUsd: "500" } },
      ).ok,
    ).toBe(true);
    expect(checkMonotonicTightening({ cost: { maxCostMicroUsd: "999999" } }, {}).ok).toBe(true);
    expect(checkMonotonicTightening({}, { cost: { maxCostMicroUsd: "1" } }).ok).toBe(true);
  });

  test("the fold (meet) picks the tighter value across all field classes", () => {
    const folded = tightenRestrictionSets(
      {
        cost: { maxCostMicroUsd: "1000" },
        quality: { minQuality: 0.5 },
        providerModel: { allowedProviders: ["a", "b"], deniedProviders: ["x"] },
        network: { egress: "allowlist" },
        isolation: { minIsolation: "process" },
      },
      {
        cost: { maxCostMicroUsd: "700" },
        quality: { minQuality: 0.9 },
        providerModel: { allowedProviders: ["a"], deniedProviders: ["x", "y"] },
        network: { egress: "none" },
        isolation: { minIsolation: "container" },
      },
    );
    expect(folded).toEqual({
      cost: { maxCostMicroUsd: "700" },
      quality: { minQuality: 0.9 },
      providerModel: { allowedProviders: ["a"], deniedProviders: ["x", "y"] },
      network: { egress: "none" },
      isolation: { minIsolation: "container" },
    });
  });
});

describe("canonical form + content-hash stability", () => {
  test("identical content in different document order hashes identically", () => {
    const set = setOf(
      platformDoc({ cost: { maxCostMicroUsd: "1000" } }),
      applicationDoc({ tool: { deniedTools: ["t"] } }),
    );
    const reordered = setOf(...[...set.documents].reverse());
    const hash = (value: unknown) =>
      createHash("sha256").update(canonicalPolicyJson(value)).digest("hex");
    expect(hash(set)).toBe(hash(reordered));
  });

  test("restriction list order and duplicates do not change the canonical form", () => {
    expect(canonicalPolicyJson({ tool: { deniedTools: ["b", "a"] } })).toBe(
      canonicalPolicyJson({ tool: { deniedTools: ["a", "b", "a"] } }),
    );
  });

  test("object key order never changes the canonical form; content changes do", () => {
    expect(
      canonicalPolicyJson({ cost: { maxCostMicroUsd: "1" }, quality: { minQuality: 1 } }),
    ).toBe(canonicalPolicyJson({ quality: { minQuality: 1 }, cost: { maxCostMicroUsd: "1" } }));
    expect(canonicalPolicyJson({ cost: { maxCostMicroUsd: "1" } })).not.toBe(
      canonicalPolicyJson({ cost: { maxCostMicroUsd: "2" } }),
    );
  });

  test("the same request resolves to byte-identical canonical results (determinism)", () => {
    const set = setOf(
      platformDoc({ cost: { maxCostMicroUsd: "1000" }, autonomy: { maxAutonomy: "sandboxed" } }),
      applicationDoc({ network: { egress: "allowlist", allowedHosts: ["a", "b"] } }),
      userDoc({ secrets: { access: "allowlist", allowedSecretRefs: ["s1"] } }),
    );
    const first = canonicalPolicyJson(resolvePolicy(set, CTX));
    for (let i = 0; i < 5; i += 1) {
      expect(canonicalPolicyJson(resolvePolicy(set, CTX))).toBe(first);
    }
  });
});
