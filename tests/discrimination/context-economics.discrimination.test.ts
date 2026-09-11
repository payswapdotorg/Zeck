/**
 * Discrimination tests — the context-economics protections (WORK-052,
 * HIGH_ASSURANCE; the worker-runbook rule: "For HIGH_ASSURANCE and
 * CRITICAL, add an explicit discrimination test that proves a
 * weakened protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-052 is
 * mutation-proven — the WEAKENED or VIOLATING form is rejected by the
 * machinery that owns it:
 *
 *  - D1 cross-tenant cache-key derivation is STRUCTURALLY
 *    unrepresentable (same semantics, different tenants → different
 *    keys; a key without tenant identity cannot be constructed; a
 *    foreign tenant claim over a real key is a typed rejection);
 *  - D2 stale-freshness serves fail closed (an expired fact is NEVER
 *    reused; a drifted-content fact is NEVER reused);
 *  - D3 cache-authorization consults are IMPOSSIBLE (the mechanical
 *    boundary proof: the plane carries no admission/authorization
 *    vocabulary, no store, no SQL — the cache plan is evidence and
 *    mechanism, never an authorization input);
 *  - D4 torn or duplicated coalescing fan-out is impossible (one
 *    leader, one promise, the exact outcome for every joiner; a
 *    post-settle arrival starts fresh — never a stale join; a
 *    mutation that would fan out different outcomes to different
 *    joiners has no code path to ride);
 *  - D5 unattributed or unbounded cost claims are rejected (context
 *    measurement AND duplication accounting);
 *  - D6 deterministic re-planning mismatches are DETECTED (identical
 *    inputs → byte-identical plans; a plan that drifted from its
 *    claimed digest fails the digest verification);
 *  - D7 memoization-annotation tampering is rejected by the consumer
 *    (the fixed annotation contract re-proven fail-closed);
 *  - D8 the in-flight coalescer is bounded (a typed rejection above
 *    the group capacity — never unbounded growth);
 *  - D9 the cache plan NEVER mutates the compiled variant (the plane
 *    consumes annotations read-only — build ON, never fork).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../src/modules/planning/public";
import { buildDuplicationAccountingRecord } from "../../src/platform/context-economics/accounting";
import { ContextEconomicsError } from "../../src/platform/context-economics/catalog";
import {
  decideCoalescing,
  deriveEquivalenceKey,
  InFlightCoalescer,
} from "../../src/platform/context-economics/coalesce";
import {
  measureContextCost,
  validateContextComposition,
} from "../../src/platform/context-economics/cost";
import {
  deriveTenantScopedCacheKey,
  validateTenantScopedCacheKey,
} from "../../src/platform/context-economics/keys";
import { readMemoizationHooks } from "../../src/platform/context-economics/memo";
import {
  planCacheDecisions,
  verifyCachePlanDigest,
} from "../../src/platform/context-economics/plan";
import {
  DEFAULT_MAX_PIPELINE_ROUNDS,
  DEFAULT_PIPELINE_PASSES,
} from "../../src/platform/execution-compiler/catalog";
import { compileExecutionIr } from "../../src/platform/execution-compiler/pipeline";
import {
  buildVariant,
  validateExecutionIrVariant,
  variantFromIr,
} from "../../src/platform/execution-compiler/variant";
import { canonicalJson } from "../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../src/platform/execution-ir/constraints";
import { deriveExecutionIr } from "../../src/platform/execution-ir/ir";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const SCOPE = {
  tenantId: "00000000-0000-7000-8000-0000000000bb",
  applicationId: "00000000-0000-7000-8000-0000000000aa",
};
const OTHER_SCOPE = {
  tenantId: "00000000-0000-7000-8000-0000000000dd",
  applicationId: "00000000-0000-7000-8000-0000000000ee",
};
const NOW = 1_800_000_000_000;
const SEMANTICS = { kind: "summarize", input: "artifact-9" };

const permissivePolicy = {
  reuseAllowed: true,
  prefixCacheAllowed: true,
  coalescingAllowed: true,
  maxEntryAgeMs: 60_000,
  maxPrefixAgeMs: 60_000,
  maxJoinAgeMs: 60_000,
};

function governedIr() {
  const plan = buildPlan(
    {
      revision: 1,
      strategyClass: "hybrid",
      steps: [
        { id: "fetch", stepClass: "retrieve", capabilityId: "document-retrieval" },
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      edges: [
        { from: "fetch", to: "gen" },
        { from: "gen", to: "check" },
      ],
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

function constraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "verification-anchor",
      kind: "verification",
      enforcement: "hard",
      source: { authority: "verification" },
      payload: { requiresVerificationAnchor: true },
    },
  ];
}

function compiledVariant() {
  const result = compileExecutionIr({
    ir: governedIr(),
    constraints: constraints(),
    config: {
      passes: DEFAULT_PIPELINE_PASSES,
      maxRounds: DEFAULT_MAX_PIPELINE_ROUNDS,
      qualityThreshold: 0.8,
    },
    digest: nodeDigest,
  });
  return result.output;
}

function freshFacts(variant: ReturnType<typeof compiledVariant>) {
  const read = readMemoizationHooks(variant);
  return read.hooks.map((hook) => ({
    key: deriveTenantScopedCacheKey(
      SCOPE,
      "memo-entry",
      { variantIrId: variant.variantIrId, memoKey: hook.memoKey },
      nodeDigest,
    ),
    contentDigest: "a".repeat(64),
    recordedAtEpochMs: NOW - 1_000,
  }));
}

// ---------------------------------------------------------------------------
// D1 — cross-tenant key derivation is structurally unrepresentable
// ---------------------------------------------------------------------------

describe("D1 cross-tenant cache keys (TENANT-ISOLATION mutation proof)", () => {
  test("the weakened form — a key derived without tenant identity — cannot be constructed", () => {
    // Mutation attempts: omit or corrupt the tenant identity. Every
    // derivation path validates the scope fail-closed.
    expect(() =>
      deriveTenantScopedCacheKey(
        { tenantId: "", applicationId: SCOPE.applicationId },
        "memo-entry",
        SEMANTICS,
        nodeDigest,
      ),
    ).toThrow(ContextEconomicsError);
    expect(() =>
      deriveTenantScopedCacheKey(
        { tenantId: "tenant-a", applicationId: SCOPE.applicationId },
        "memo-entry",
        SEMANTICS,
        nodeDigest,
      ),
    ).toThrow(ContextEconomicsError);
  });

  test("identical semantics under different tenants can NEVER derive the same key", () => {
    const mine = deriveTenantScopedCacheKey(SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    const theirs = deriveTenantScopedCacheKey(OTHER_SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    expect(mine.key).not.toBe(theirs.key);
    // 100 distinct semantics × 2 tenants: zero cross-tenant key
    // collisions (the structural property, not a filter).
    let collisions = 0;
    for (let index = 0; index < 100; index += 1) {
      const semantics = { kind: "work", index };
      const a = deriveTenantScopedCacheKey(SCOPE, "memo-entry", semantics, nodeDigest);
      const b = deriveTenantScopedCacheKey(OTHER_SCOPE, "memo-entry", semantics, nodeDigest);
      if (a.key === b.key) {
        collisions += 1;
      }
    }
    expect(collisions).toBe(0);
  });

  test("a mutation claiming the other tenant over a real key is a typed identity rejection", () => {
    const real = deriveTenantScopedCacheKey(SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    const forged = { ...real, tenantId: OTHER_SCOPE.tenantId };
    expect(() => validateTenantScopedCacheKey(forged, nodeDigest)).toThrow(
      /does not cover its claimed tenant identity/,
    );
    // And the reverse forgery (claiming MY tenant over THEIR key).
    const reverse = { ...real, key: "f".repeat(64) };
    expect(() => validateTenantScopedCacheKey(reverse, nodeDigest)).toThrow(ContextEconomicsError);
  });

  test("a cross-tenant cache fact can never satisfy the other tenant's plan", () => {
    const variant = compiledVariant();
    const facts = freshFacts(variant);
    // The plan under the OTHER tenant's scope with tenant-A facts.
    const plan = planCacheDecisions(
      { variant, facts, policy: permissivePolicy, scope: OTHER_SCOPE, nowEpochMs: NOW },
      nodeDigest,
    );
    expect(plan.reuseCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D2 — stale-freshness serves fail closed
// ---------------------------------------------------------------------------

describe("D2 stale freshness (fail-closed reuse)", () => {
  test("an EXPIRED fact is never served — the site computes with the exact reason", () => {
    const variant = compiledVariant();
    const read = readMemoizationHooks(variant);
    const staleFacts = read.hooks.map((hook) => ({
      key: deriveTenantScopedCacheKey(
        SCOPE,
        "memo-entry",
        { variantIrId: variant.variantIrId, memoKey: hook.memoKey },
        nodeDigest,
      ),
      contentDigest: "a".repeat(64),
      recordedAtEpochMs: NOW - 61_000, // 1ms past the 60s bound
    }));
    const plan = planCacheDecisions(
      { variant, facts: staleFacts, policy: permissivePolicy, scope: SCOPE, nowEpochMs: NOW },
      nodeDigest,
    );
    expect(plan.reuseCount).toBe(0);
    for (const decision of plan.siteDecisions) {
      if (read.hooks.some((hook) => hook.stepId === decision.stepId)) {
        expect(decision.reason).toBe("freshness-expired");
      }
    }
  });

  test("a CONTENT-DRIFTED fact (semantics digest mismatch) is never served", () => {
    const variant = compiledVariant();
    const read = readMemoizationHooks(variant);
    // A fact whose key was derived over DIFFERENT semantics but
    // manually re-keyed to match the current cache key — the drift
    // shows up as the semanticsDigest mismatch.
    const driftedFacts = read.hooks.map((hook) => {
      const foreignKey = deriveTenantScopedCacheKey(
        SCOPE,
        "memo-entry",
        { variantIrId: "0".repeat(64), memoKey: hook.memoKey },
        nodeDigest,
      );
      return {
        key: {
          ...foreignKey,
          key: deriveTenantScopedCacheKey(
            SCOPE,
            "memo-entry",
            { variantIrId: variant.variantIrId, memoKey: hook.memoKey },
            nodeDigest,
          ).key,
        },
        contentDigest: "a".repeat(64),
        recordedAtEpochMs: NOW - 1_000,
      };
    });
    // The tampered facts are rejected at validation (the key no
    // longer covers its own claims) — never silently served.
    expect(() =>
      planCacheDecisions(
        { variant, facts: driftedFacts, policy: permissivePolicy, scope: SCOPE, nowEpochMs: NOW },
        nodeDigest,
      ),
    ).toThrow(ContextEconomicsError);
  });
});

// ---------------------------------------------------------------------------
// D3 — cache-authorization consults are impossible (mechanical boundary)
// ---------------------------------------------------------------------------

describe("D3 the cache is never an authority (ECONOMIC-AUTHORITY-BOUNDARY mechanical proof)", () => {
  const PLANE_DIR = join(REPO_ROOT, "src/platform/context-economics");
  const PLANE_FILES = readdirSync(PLANE_DIR)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(PLANE_DIR, name))
    .sort();

  test("the plane carries no admission/authorization vocabulary", () => {
    expect(PLANE_FILES.length).toBe(7);
    for (const file of PLANE_FILES) {
      const content = readFileSync(file, "utf8");
      for (const word of [
        "authorize",
        "authorization",
        "admission",
        "approve",
        "reserve",
        "settle",
        "permit",
        "grant",
      ]) {
        expect(content, `${file} must not expose "${word}"`).not.toContain(`readonly ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`function ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toContain(`async ${word}`);
        expect(content, `${file} must not expose "${word}"`).not.toMatch(
          new RegExp(`(?:type|interface)\\s+${word}\\b`, "i"),
        );
      }
    }
  });

  test("the plane holds NO store, NO SQL, NO db import, NO migration (no second durable surface)", () => {
    for (const file of PLANE_FILES) {
      const content = readFileSync(file, "utf8");
      expect(content, `${file} must not carry SQL`).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|SELECT\s+.*\s+FROM|CREATE\s+TABLE)\b/,
      );
      expect(content, `${file} must not import the db port`).not.toContain("../db/");
      expect(content, `${file} must not import the db port`).not.toContain("DatabasePort");
      expect(content, `${file} must not implement a store`).not.toContain(
        "implements OptimizationDecisionStore",
      );
    }
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(30);
    expect(migrations[migrations.length - 1]).toMatch(/^0031_audit_compliance/);
  });

  test("NO module/integration/api file references the plane (nothing depends on it for authority)", () => {
    const dirs = ["src/modules", "src/integrations", "src/api"];
    for (const dir of dirs) {
      const walk = (current: string): string[] => {
        const out: string[] = [];
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            out.push(...walk(full));
          } else if (entry.name.endsWith(".ts")) {
            out.push(full);
          }
        }
        return out;
      };
      for (const file of walk(join(REPO_ROOT, dir))) {
        const content = readFileSync(file, "utf8");
        expect(content, `${file} must not reference the context-economics plane`).not.toContain(
          "context-economics",
        );
      }
    }
  });

  test("the cache plan output carries no authorization semantics (evidence, not permission)", () => {
    const variant = compiledVariant();
    const plan = planCacheDecisions(
      {
        variant,
        facts: freshFacts(variant),
        policy: permissivePolicy,
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    const serialized = JSON.stringify(plan);
    for (const word of ["allow", "deny", "permitted", "authorized", "admission"]) {
      expect(serialized).not.toContain(word);
    }
    // The decisions are reuse/compute only — the closed vocabulary.
    for (const decision of plan.siteDecisions) {
      expect(["reuse", "compute"]).toContain(decision.decision);
    }
  });
});

// ---------------------------------------------------------------------------
// D4 — torn or duplicated coalescing fan-out is impossible
// ---------------------------------------------------------------------------

describe("D4 coalescing fan-out integrity (CONCURRENCY-CRASH-SAFETY mutation proof)", () => {
  test("the exact-outcome fan-out: every joiner observes the leader's IDENTICAL value", async () => {
    const coalescer = new InFlightCoalescer();
    let executions = 0;
    const leaderOutcome = { value: "immutable-leader-outcome", stamp: 7 };
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        coalescer.join(SCOPE, SEMANTICS, nodeDigest, async () => {
          executions += 1;
          return leaderOutcome;
        }),
      ),
    );
    expect(executions).toBe(1);
    // No joiner can observe a different value: one promise, N awaiters.
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe(leaderOutcome);
    }
    const leaders = outcomes.filter((outcome) => outcome.role === "leader");
    const joiners = outcomes.filter((outcome) => outcome.role === "joiner");
    expect(leaders).toHaveLength(1);
    expect(joiners).toHaveLength(11);
    // The count is consistent across the fan-out (no torn counting).
    for (const outcome of outcomes) {
      expect(outcome.joinerCount).toBe(11);
    }
  });

  test("the torn-fan-out mutation (joiners reading different outcomes) has no code path", async () => {
    const coalescer = new InFlightCoalescer();
    // A leader whose work resolves ONCE: the joiners attach to the
    // same promise — a divergent fan-out would require resolving it
    // twice, which the single-entry registry makes impossible.
    let resolveCount = 0;
    const outcomes = await Promise.all([
      coalescer.join(SCOPE, SEMANTICS, nodeDigest, async () => {
        resolveCount += 1;
        return { resolution: resolveCount };
      }),
      coalescer.join(SCOPE, SEMANTICS, nodeDigest, async () => {
        throw new Error("the joiner's own work must NEVER run");
      }),
    ]);
    // The joiner's work never executed; it observed the leader's
    // outcome instead (the coalesced semantics).
    expect(resolveCount).toBe(1);
    expect(outcomes[1]?.role).toBe("joiner");
    expect(outcomes[1]?.outcome).toEqual(outcomes[0]?.outcome);
  });

  test("a post-settle arrival NEVER joins the settled group (no stale joins)", async () => {
    const coalescer = new InFlightCoalescer();
    const first = await coalescer.join(SCOPE, SEMANTICS, nodeDigest, async () => "first-outcome");
    expect(first.joinerCount).toBe(0);
    // The group is gone: a fresh joiner leads a fresh group.
    let executed = 0;
    const second = await coalescer.join(SCOPE, SEMANTICS, nodeDigest, async () => {
      executed += 1;
      return "second-outcome";
    });
    expect(executed).toBe(1);
    expect(second.role).toBe("leader");
    expect(second.outcome).toBe("second-outcome");
    expect(second.outcome).not.toBe(first.outcome);
  });

  test("the failure fan-out cannot be partially swallowed: every joiner rejects identically", async () => {
    const coalescer = new InFlightCoalescer();
    const failure = new Error("deterministic-failure");
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        coalescer.join(SCOPE, SEMANTICS, nodeDigest, async () => {
          throw failure;
        }),
      ),
    );
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBe(failure);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// D5 — unattributed or unbounded cost claims are rejected
// ---------------------------------------------------------------------------

describe("D5 cost-claim attribution and bounds (mutation proof)", () => {
  test("an unattributed context segment is rejected", () => {
    expect(() =>
      validateContextComposition({
        segments: [
          {
            kind: "user-input",
            tokenCount: 1,
            basis: undefined as never,
          },
        ],
      }),
    ).toThrow(/estimation basis/);
  });

  test("an unattributed pricing fact is rejected at measurement", () => {
    expect(() =>
      measureContextCost(
        {
          composition: {
            segments: [
              { kind: "user-input", tokenCount: 1, basis: { basis: "observed", source: "s" } },
            ],
          },
          pricing: { microUsdPerMillionTokens: "1000", basis: undefined as never },
        },
        nodeDigest,
      ),
    ).toThrow(/estimation basis/);
  });

  test("an unbounded token count is rejected", () => {
    expect(() =>
      validateContextComposition({
        segments: [
          {
            kind: "user-input",
            tokenCount: Number.MAX_SAFE_INTEGER,
            basis: { basis: "observed", source: "s" },
          },
        ],
      }),
    ).toThrow(ContextEconomicsError);
  });

  test("an unattributed accounting claim is rejected BEFORE the record exists", () => {
    const ir = governedIr();
    expect(() =>
      buildDuplicationAccountingRecord(
        {
          ir,
          constraints: constraints(),
          scope: { applicationId: SCOPE.applicationId, tenantId: SCOPE.tenantId },
          outcome: {
            kind: "cache-reuse",
            cacheKey: "a".repeat(64),
            contentDigest: "b".repeat(64),
            memoKey: "c".repeat(64),
          },
          economics: {
            freshExecution: {
              expectedCostMicroUsd: "500000",
              expectedLatencyMs: 2000,
              expectedQuality: 0.95,
              expectedReliability: 0.9,
              basis: { basis: "guessed" as never, source: "nowhere" },
            },
            avoidedExecution: {
              expectedCostMicroUsd: "10",
              expectedLatencyMs: 40,
              expectedQuality: 0.95,
              expectedReliability: 1,
              basis: { basis: "observed", source: "context-economics.cache-observer" },
            },
          },
          qualityThreshold: 0.8,
          recordedAt: "2026-09-22T12:00:00.000Z",
        },
        nodeDigest,
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// D6 — deterministic re-planning mismatches are detected
// ---------------------------------------------------------------------------

describe("D6 planning determinism drift detection", () => {
  test("identical inputs produce the byte-identical plan (the determinism baseline)", () => {
    const variant = compiledVariant();
    const input = {
      variant,
      facts: freshFacts(variant),
      policy: permissivePolicy,
      scope: SCOPE,
      nowEpochMs: NOW,
    };
    const first = planCacheDecisions(input, nodeDigest);
    const second = planCacheDecisions(input, nodeDigest);
    expect(first.planDigest).toBe(second.planDigest);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  test("a MUTATED plan (drifted decisions under the claimed digest) is DETECTED", () => {
    const variant = compiledVariant();
    const plan = planCacheDecisions(
      {
        variant,
        facts: freshFacts(variant),
        policy: permissivePolicy,
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    expect(verifyCachePlanDigest(plan, nodeDigest).ok).toBe(true);
    // Mutation 1: flip a reuse decision to compute.
    const flipped = {
      ...plan,
      siteDecisions: plan.siteDecisions.map((decision) =>
        decision.stepId === plan.siteDecisions[0]?.stepId && decision.decision === "reuse"
          ? { ...decision, decision: "compute" as const, reason: "freshness-no-fact" as const }
          : decision,
      ),
    };
    expect(verifyCachePlanDigest(flipped, nodeDigest).ok).toBe(false);
    // Mutation 2: change the claimed variant identity.
    const reidentified = { ...plan, variantIrId: "0".repeat(64) };
    expect(verifyCachePlanDigest(reidentified, nodeDigest).ok).toBe(false);
    // Mutation 3: change the planning instant.
    const retime = { ...plan, nowEpochMs: NOW + 1 };
    expect(verifyCachePlanDigest(retime, nodeDigest).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D7 — memoization-annotation tampering is rejected by the consumer
// ---------------------------------------------------------------------------

describe("D7 annotation-contract tampering (the consumer re-proves the fixed contract)", () => {
  test("a hook forged onto a probabilistic step is never consumed", () => {
    const ir = governedIr();
    const variant = variantFromIr(ir, nodeDigest);
    const mutated = buildVariant(
      {
        source: variant,
        steps: variant.steps.map((step) =>
          step.id === "gen"
            ? {
                ...step,
                config: {
                  ...step.config,
                  "execution-compiler": { "memoization-hooks": { memoKey: "0".repeat(64) } },
                },
              }
            : step,
        ),
        edges: variant.edges,
        provenance: variant.provenance,
      },
      nodeDigest,
    );
    const read = readMemoizationHooks(mutated);
    expect(read.hooks.find((hook) => hook.stepId === "gen")).toBeUndefined();
    expect(read.rejections.find((rejection) => rejection.stepId === "gen")).toBeDefined();
  });

  test("a plan over a TAMPERED variant records the site as invalid (never reused)", () => {
    const ir = governedIr();
    const variant = variantFromIr(ir, nodeDigest);
    const mutated = buildVariant(
      {
        source: variant,
        steps: variant.steps.map((step) =>
          step.id === "gen"
            ? {
                ...step,
                config: {
                  ...step.config,
                  "execution-compiler": { "memoization-hooks": { memoKey: "0".repeat(64) } },
                },
              }
            : step,
        ),
        edges: variant.edges,
        provenance: variant.provenance,
      },
      nodeDigest,
    );
    const plan = planCacheDecisions(
      { variant: mutated, facts: [], policy: permissivePolicy, scope: SCOPE, nowEpochMs: NOW },
      nodeDigest,
    );
    const genDecision = plan.siteDecisions.find((decision) => decision.stepId === "gen");
    expect(genDecision?.decision).toBe("compute");
    expect(genDecision?.reason).toBe("semantics-hook-invalid");
  });
});

// ---------------------------------------------------------------------------
// D8 — the in-flight coalescer is bounded
// ---------------------------------------------------------------------------

describe("D8 the coalescer bound (typed rejection above capacity)", () => {
  test("exceeding the group capacity is a typed rejection, never unbounded growth", async () => {
    const coalescer = new InFlightCoalescer();
    // MAX_COALESCE_GROUPS concurrent DISTINCT groups, parked in flight
    // until we release them.
    const resolvers: Array<(value: string) => void> = [];
    const parked = Array.from({ length: 1024 }, (_, index) =>
      coalescer.join(
        SCOPE,
        { kind: "work", index },
        nodeDigest,
        () => new Promise<string>((resolve) => resolvers.push(resolve)),
      ),
    );
    expect(coalescer.inFlightGroups).toBe(1024);
    // The 1025th DISTINCT group is a typed rejection (fail closed —
    // never unbounded growth).
    await expect(
      coalescer.join(SCOPE, { kind: "work", index: 1024 }, nodeDigest, async () => "never"),
    ).rejects.toThrow(ContextEconomicsError);
    // An EXISTING group's key still joins (the bound applies to new
    // groups, not to joining duplicate work).
    const joiner = coalescer.join(
      SCOPE,
      { kind: "work", index: 0 },
      nodeDigest,
      async () => "never-runs",
    );
    // Release the parked leaders.
    for (const resolve of resolvers) {
      resolve("done");
    }
    await expect(parked[0]).resolves.toMatchObject({ outcome: "done", role: "leader" });
    await expect(joiner).resolves.toMatchObject({ role: "joiner", outcome: "done" });
  });
});

// ---------------------------------------------------------------------------
// D9 — the plane consumes annotations read-only (build ON, never fork)
// ---------------------------------------------------------------------------

describe("D9 read-only annotation consumption (the variant is never mutated)", () => {
  test("reading hooks and planning leave the compiled variant byte-identical", () => {
    const variant = compiledVariant();
    const before = canonicalJson(validateExecutionIrVariant(variant, nodeDigest));
    readMemoizationHooks(variant);
    planCacheDecisions(
      {
        variant,
        facts: freshFacts(variant),
        policy: permissivePolicy,
        scope: SCOPE,
        nowEpochMs: NOW,
      },
      nodeDigest,
    );
    const after = canonicalJson(validateExecutionIrVariant(variant, nodeDigest));
    expect(after).toBe(before);
  });

  test("the plane never writes the reserved compiler annotation key (import-only consumption)", () => {
    const planeDir = join(REPO_ROOT, "src/platform/context-economics");
    for (const name of readdirSync(planeDir).filter((entry) => entry.endsWith(".ts"))) {
      const content = readFileSync(join(planeDir, name), "utf8");
      // The only legal reference to the reserved key is the read-side
      // import from the compiler's semantics module.
      if (content.includes('["execution-compiler"]') || content.includes('"execution-compiler"')) {
        expect(name).toBe("memo.ts");
        expect(content).toContain('from "../execution-compiler/semantics"');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Coalescing decision vocabulary safety (supporting discrimination)
// ---------------------------------------------------------------------------

describe("coalescing decision invariants (supporting D3/D4)", () => {
  test("the pure decision never leaks execution status vocabulary (no second state machine)", () => {
    const key = deriveEquivalenceKey(SCOPE, SEMANTICS, nodeDigest);
    const decision = decideCoalescing({
      candidates: [
        {
          executionId: "exec-1",
          equivalenceKey: key,
          startedAtEpochMs: NOW - 1_000,
        },
      ],
      equivalenceKey: key,
      policy: permissivePolicy,
      nowEpochMs: NOW,
    });
    const serialized = JSON.stringify(decision);
    for (const state of ["CREATED", "AUTHORIZED", "RUNNING", "COMPLETED", "FAILED", "QUEUED"]) {
      expect(serialized).not.toContain(state);
    }
  });
});
