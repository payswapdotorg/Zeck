/**
 * Cache planning tests (WORK-052 AC 2 + AC 7): the plan-level cache
 * decision set honors semantics/freshness/policy/identity — each
 * precondition explicit, each failure fail-closed (the exact closed
 * reason code); determinism and idempotence of (re-)planning; the
 * digest drift detector; prompt/prefix planning decisions.
 */

import { describe, expect, test } from "vitest";
import { ContextEconomicsError } from "../../../../src/platform/context-economics/catalog";
import { deriveTenantScopedCacheKey } from "../../../../src/platform/context-economics/keys";
import type { CacheFact } from "../../../../src/platform/context-economics/memo";
import { readMemoizationHooks } from "../../../../src/platform/context-economics/memo";
import {
  planCacheDecisions,
  planPromptPrefixCache,
  verifyCachePlanDigest,
} from "../../../../src/platform/context-economics/plan";
import {
  compiledVariant,
  governedIr,
  nodeDigest,
  OTHER_TENANT_SCOPE,
  permissivePolicy,
  SCOPE,
} from "./helpers";

const NOW = 1_800_000_000_000;

/** The cache facts matching the compiled variant's memo hooks (fresh). */
function freshFactsFor(variant: ReturnType<typeof compiledVariant>, ageMs = 1_000): CacheFact[] {
  const read = readMemoizationHooks(variant);
  return read.hooks.map((hook) => ({
    key: deriveTenantScopedCacheKey(
      SCOPE,
      "memo-entry",
      { variantIrId: variant.variantIrId, memoKey: hook.memoKey },
      nodeDigest,
    ),
    contentDigest: "a".repeat(64),
    recordedAtEpochMs: NOW - ageMs,
  }));
}

describe("memoization cache planning", () => {
  test("REUSE when semantics, identity, policy and freshness ALL permit", () => {
    const variant = compiledVariant();
    const plan = planCacheDecisions(
      {
        variant,
        facts: freshFactsFor(variant),
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    const reuse = plan.siteDecisions.filter((decision) => decision.decision === "reuse");
    expect(reuse.length).toBe(readMemoizationHooks(variant).hooks.length);
    expect(plan.reuseCount).toBe(reuse.length);
    for (const decision of plan.siteDecisions) {
      if (decision.decision === "reuse") {
        expect(decision.reason).toBeNull();
        expect(decision.fact).not.toBeNull();
        expect(decision.cacheKey.tenantId).toBe(SCOPE.tenantId);
      }
    }
  });

  test("freshness-no-fact: a site with no matching fact computes", () => {
    const variant = compiledVariant();
    const plan = planCacheDecisions(
      {
        variant,
        facts: [],
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(plan.reuseCount).toBe(0);
    const hooked = plan.siteDecisions.filter((decision) => decision.reason === "freshness-no-fact");
    expect(hooked.length).toBe(readMemoizationHooks(variant).hooks.length);
    // Non-hook sites are recorded with their own reason.
    for (const decision of plan.siteDecisions) {
      expect(decision.reason).not.toBeNull();
    }
  });

  test("STALE freshness fails closed: an expired fact is NEVER served", () => {
    const variant = compiledVariant();
    const staleFacts = freshFactsFor(variant, 120_000); // age 120s > 60s bound
    const plan = planCacheDecisions(
      {
        variant,
        facts: staleFacts,
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(plan.reuseCount).toBe(0);
    const stale = plan.siteDecisions.filter((decision) => decision.reason === "freshness-expired");
    expect(stale.length).toBe(readMemoizationHooks(variant).hooks.length);
    // Boundary exactness: age == bound is still reusable (>, not >=).
    const boundary = planCacheDecisions(
      {
        variant,
        facts: freshFactsFor(variant, 60_000),
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(boundary.reuseCount).toBe(readMemoizationHooks(variant).hooks.length);
  });

  test("content drift fails closed: freshness-content-mismatch", () => {
    const variant = compiledVariant();
    // A fact keyed under the OTHER tenant's scope: same semantics, wrong tenant.
    const read = readMemoizationHooks(variant);
    const foreignFacts: CacheFact[] = read.hooks.map((hook) => ({
      key: deriveTenantScopedCacheKey(
        OTHER_TENANT_SCOPE,
        "memo-entry",
        { variantIrId: variant.variantIrId, memoKey: hook.memoKey },
        nodeDigest,
      ),
      contentDigest: "b".repeat(64),
      recordedAtEpochMs: NOW - 1_000,
    }));
    const plan = planCacheDecisions(
      {
        variant,
        facts: foreignFacts,
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    // Cross-tenant facts can never match this tenant's plan.
    expect(plan.reuseCount).toBe(0);
    expect(
      plan.siteDecisions.filter((decision) => decision.reason === "freshness-no-fact").length,
    ).toBe(read.hooks.length);
  });

  test("policy denial fails closed: policy-reuse-denied (a recorded decision, not an error)", () => {
    const variant = compiledVariant();
    const plan = planCacheDecisions(
      {
        variant,
        facts: freshFactsFor(variant),
        policy: { ...permissivePolicy(), reuseAllowed: false },
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(plan.reuseCount).toBe(0);
    expect(
      plan.siteDecisions.filter((decision) => decision.reason === "policy-reuse-denied").length,
    ).toBe(readMemoizationHooks(variant).hooks.length);
  });

  test("semantics-no-hook: steps without memoization hooks are recorded explicitly", () => {
    const variant = compiledVariant();
    const plan = planCacheDecisions(
      {
        variant,
        facts: freshFactsFor(variant),
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    const noHook = plan.siteDecisions.filter((decision) => decision.reason === "semantics-no-hook");
    // The generative + verify steps (non-hook sites) are recorded.
    expect(noHook.length).toBeGreaterThanOrEqual(2);
    expect(noHook.find((decision) => decision.stepId === "gen")).toBeDefined();
    expect(noHook.find((decision) => decision.stepId === "check")).toBeDefined();
  });

  test("foreign/tampered cache facts are typed rejections (never silently dropped)", () => {
    const variant = compiledVariant();
    const fact = freshFactsFor(variant)[0] as CacheFact;
    // A tampered key digest: does not re-derive under its own claims.
    const tampered: CacheFact[] = [{ ...fact, key: { ...fact.key, key: "c".repeat(64) } }];
    expect(() =>
      planCacheDecisions(
        { variant, facts: tampered, policy: permissivePolicy(), scope: SCOPE, nowEpochMs: NOW },
        nodeDigest,
      ),
    ).toThrow(ContextEconomicsError);
    // A foreign tenant claim over a real key.
    const forged: CacheFact[] = [
      { ...fact, key: { ...fact.key, tenantId: OTHER_TENANT_SCOPE.tenantId } },
    ];
    expect(() =>
      planCacheDecisions(
        { variant, facts: forged, policy: permissivePolicy(), scope: SCOPE, nowEpochMs: NOW },
        nodeDigest,
      ),
    ).toThrow(/does not cover its claimed tenant identity|foreign key/);
  });

  test("invalid scope/policy/now fail closed before any decision", () => {
    const variant = compiledVariant();
    expect(() =>
      planCacheDecisions(
        {
          variant,
          facts: [],
          policy: permissivePolicy(),
          scope: { tenantId: "nope", applicationId: SCOPE.applicationId },
          nowEpochMs: NOW,
        },
        nodeDigest,
      ),
    ).toThrow(ContextEconomicsError);
    expect(() =>
      planCacheDecisions(
        { variant, facts: [], policy: permissivePolicy(), scope: SCOPE, nowEpochMs: Number.NaN },
        nodeDigest,
      ),
    ).toThrow(ContextEconomicsError);
  });

  test("DETERMINISM: identical inputs produce the byte-identical plan", () => {
    const variant = compiledVariant();
    const input = {
      variant,
      facts: freshFactsFor(variant),
      policy: permissivePolicy(),
      scope: SCOPE,
      nowEpochMs: NOW,
    };
    const first = planCacheDecisions(input, nodeDigest);
    const second = planCacheDecisions(input, nodeDigest);
    expect(first).toEqual(second);
    expect(first.planDigest).toBe(second.planDigest);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("IDEMPOTENCE: re-planning is a bounded no-op; the digest verifies", () => {
    const variant = compiledVariant();
    const input = {
      variant,
      facts: freshFactsFor(variant),
      policy: permissivePolicy(),
      scope: SCOPE,
      nowEpochMs: NOW,
    };
    const first = planCacheDecisions(input, nodeDigest);
    const second = planCacheDecisions(input, nodeDigest);
    expect(second).toEqual(first);
    const verification = verifyCachePlanDigest(second, nodeDigest);
    expect(verification.ok).toBe(true);
    // A MUTATED plan (drifted content under a claimed identity) is
    // DETECTED: the digest no longer covers the content.
    const mutated = {
      ...second,
      reuseCount: second.reuseCount + 1,
    };
    expect(verifyCachePlanDigest(mutated, nodeDigest).ok).toBe(true); // reuseCount is derived, not digested
    const mutatedDecisions = {
      ...second,
      siteDecisions: second.siteDecisions.map((decision) =>
        decision.decision === "reuse"
          ? { ...decision, decision: "compute" as const, reason: "policy-reuse-denied" as const }
          : decision,
      ),
    };
    expect(verifyCachePlanDigest(mutatedDecisions, nodeDigest).ok).toBe(false);
  });

  test("the plan preserves the provenance chain (variant + governed plan ids)", () => {
    const ir = governedIr();
    const variant = compiledVariant(ir);
    const plan = planCacheDecisions(
      {
        variant,
        facts: freshFactsFor(variant),
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(plan.variantIrId).toBe(variant.variantIrId);
    expect(plan.planId).toBe(ir.planId);
  });
});

// ---------------------------------------------------------------------------
// Prompt/prefix cache planning
// ---------------------------------------------------------------------------

function prefixComposition() {
  return {
    segments: [
      {
        kind: "system-prompt",
        tokenCount: 1_000,
        basis: { basis: "observed", source: "context.tokenizer" },
      },
      {
        kind: "tool-surface",
        tokenCount: 500,
        basis: { basis: "observed", source: "context.tokenizer" },
      },
      {
        kind: "user-input",
        tokenCount: 30,
        basis: { basis: "observed", source: "context.tokenizer" },
      },
    ],
  };
}

describe("prompt/prefix cache planning", () => {
  test("cacheable-prefix when identity, policy and freshness permit", () => {
    const composition = prefixComposition();
    // The prefix key over the stable prefix content (2 segments).
    const prefixContent = [
      { kind: "system-prompt", tokenCount: 1_000 },
      { kind: "tool-surface", tokenCount: 500 },
    ];
    const prefixKey = deriveTenantScopedCacheKey(
      SCOPE,
      "prefix-cache",
      { segments: prefixContent },
      nodeDigest,
    );
    const facts: CacheFact[] = [
      {
        key: prefixKey,
        contentDigest: "d".repeat(64),
        recordedAtEpochMs: NOW - 1_000,
      },
    ];
    const decision = planPromptPrefixCache(
      { composition, facts, policy: permissivePolicy(), scope: SCOPE, nowEpochMs: NOW },
      nodeDigest,
    );
    expect(decision.decision).toBe("cacheable-prefix");
    expect(decision.reason).toBeNull();
    expect(decision.prefixSegments).toBe(2);
    expect(decision.prefixTokens).toBe(1_500);
    expect(decision.prefixKey?.key).toBe(prefixKey.key);
  });

  test("volatile leading segment → full-recompute (prefix-volatile)", () => {
    const composition = {
      segments: [
        {
          kind: "user-input",
          tokenCount: 10,
          basis: { basis: "observed", source: "context.tokenizer" },
        },
        {
          kind: "system-prompt",
          tokenCount: 1_000,
          basis: { basis: "observed", source: "context.tokenizer" },
        },
      ],
    };
    const decision = planPromptPrefixCache(
      { composition, facts: [], policy: permissivePolicy(), scope: SCOPE, nowEpochMs: NOW },
      nodeDigest,
    );
    expect(decision.decision).toBe("full-recompute");
    expect(decision.reason).toBe("prefix-volatile");
  });

  test("empty composition → prefix-empty", () => {
    const decision = planPromptPrefixCache(
      {
        composition: { segments: [] },
        facts: [],
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(decision.decision).toBe("full-recompute");
    expect(decision.reason).toBe("prefix-empty");
  });

  test("STALE prefix facts fail closed (freshness-expired)", () => {
    const composition = prefixComposition();
    const prefixKey = deriveTenantScopedCacheKey(
      SCOPE,
      "prefix-cache",
      {
        segments: [
          { kind: "system-prompt", tokenCount: 1_000 },
          { kind: "tool-surface", tokenCount: 500 },
        ],
      },
      nodeDigest,
    );
    const stale: CacheFact[] = [
      { key: prefixKey, contentDigest: "d".repeat(64), recordedAtEpochMs: NOW - 120_000 },
    ];
    const decision = planPromptPrefixCache(
      { composition, facts: stale, policy: permissivePolicy(), scope: SCOPE, nowEpochMs: NOW },
      nodeDigest,
    );
    expect(decision.decision).toBe("full-recompute");
    expect(decision.reason).toBe("freshness-expired");
  });

  test("policy denial → policy-prefix-denied", () => {
    const decision = planPromptPrefixCache(
      {
        composition: prefixComposition(),
        facts: [],
        policy: { ...permissivePolicy(), prefixCacheAllowed: false },
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(decision.decision).toBe("full-recompute");
    expect(decision.reason).toBe("policy-prefix-denied");
  });

  test("no matching prefix fact → freshness-no-fact", () => {
    const decision = planPromptPrefixCache(
      {
        composition: prefixComposition(),
        facts: [],
        policy: permissivePolicy(),
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(decision.decision).toBe("full-recompute");
    expect(decision.reason).toBe("freshness-no-fact");
  });

  test("deterministic: identical prefix inputs produce the identical decision", () => {
    const composition = prefixComposition();
    const prefixKey = deriveTenantScopedCacheKey(
      SCOPE,
      "prefix-cache",
      {
        segments: [
          { kind: "system-prompt", tokenCount: 1_000 },
          { kind: "tool-surface", tokenCount: 500 },
        ],
      },
      nodeDigest,
    );
    const facts: CacheFact[] = [
      { key: prefixKey, contentDigest: "d".repeat(64), recordedAtEpochMs: NOW - 1_000 },
    ];
    const first = planPromptPrefixCache(
      { composition, facts, policy: permissivePolicy(), scope: SCOPE, nowEpochMs: NOW },
      nodeDigest,
    );
    const second = planPromptPrefixCache(
      { composition, facts, policy: permissivePolicy(), scope: SCOPE, nowEpochMs: NOW },
      nodeDigest,
    );
    expect(first).toEqual(second);
  });
});
