/**
 * Unit: policy authority — publish arbitration, deny-by-default, admission
 * and dispatch evaluation, admission evidence (WORK-007 acceptance criteria
 * 2, 4, 5 over the REAL authority with in-memory store + node hasher).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  canonicalPolicyJson,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyDocument,
  type PolicySet,
} from "../../../src/modules/policies/public";
import { PlatformError } from "../../../src/shared/errors";

const TENANT = "tenant-1";
const APP = "app-1";
const USER = "user-1";
const CTX = { tenantId: TENANT, applicationId: APP, userId: USER, taskKind: "summarize" };

const baseSet: PolicySet = {
  id: "default",
  version: 1,
  documents: [
    {
      scope: "platform",
      selector: {},
      restrictions: {
        cost: { maxCostMicroUsd: "1000" },
        latency: { maxLatencyMs: 5000 },
        providerModel: { allowedProviders: ["rail-a", "rail-b"] },
        tool: { deniedTools: ["terminal"] },
        network: { egress: "allowlist", allowedHosts: ["api.example"] },
        secrets: { access: "allowlist", allowedSecretRefs: ["conn-1"] },
        autonomy: { maxAutonomy: "sandboxed" },
        isolation: { minIsolation: "process" },
        quality: { minQuality: 0.5 },
      },
    },
  ],
};

async function world(set?: PolicySet) {
  const store = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store, hasher: nodePolicyHasher });
  if (set !== undefined) {
    await authority.publish(set);
  }
  return { store, authority };
}

const firstDoc = (set: PolicySet): PolicyDocument => set.documents[0] as PolicyDocument;
const expectedHash = (set: PolicySet): string =>
  createHash("sha256").update(canonicalPolicyJson(set)).digest("hex");

describe("policy authority: publish arbitration", () => {
  test("a valid set publishes with content-hash identity", async () => {
    const { authority } = await world();
    const outcome = await authority.publish(baseSet);
    expect(outcome).toEqual({
      status: "published",
      identity: { id: "default", version: 1, contentHash: expectedHash(baseSet) },
    });
  });

  test("an identical republish converges (no second publication)", async () => {
    const { authority } = await world();
    await authority.publish(baseSet);
    const again = await authority.publish(structuredClone(baseSet));
    expect(again.status).toBe("converged");
    const record = await authority.current();
    expect(record?.set.version).toBe(1);
  });

  test("a version rollback is rejected (monotonic versions only)", async () => {
    const { authority } = await world();
    await authority.publish(baseSet);
    const rollback = { ...baseSet, documents: [...baseSet.documents], version: 1 };
    rollback.documents[0] = {
      ...(rollback.documents[0] as PolicyDocument),
      restrictions: { cost: { maxCostMicroUsd: "2000" } },
    };
    await expect(authority.publish({ ...rollback, version: 1 })).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
  });

  test("an equal version with different content is rejected", async () => {
    const { authority } = await world();
    await authority.publish(baseSet);
    const conflicting: PolicySet = {
      ...baseSet,
      documents: [{ ...firstDoc(baseSet), restrictions: { cost: { maxCostMicroUsd: "2" } } }],
    };
    await expect(authority.publish(conflicting)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
  });

  test("a higher version replaces the current set (new identity)", async () => {
    const { authority } = await world();
    await authority.publish(baseSet);
    const next: PolicySet = {
      ...baseSet,
      version: 2,
      documents: [{ ...firstDoc(baseSet), restrictions: { cost: { maxCostMicroUsd: "500" } } }],
    };
    const outcome = await authority.publish(next);
    expect(outcome.status).toBe("published");
    expect(outcome.identity.version).toBe(2);
    const current = await authority.current();
    expect(current?.set.version).toBe(2);
  });

  test("malformed policy data fails closed at publish", async () => {
    const { authority } = await world();
    await expect(
      authority.publish({
        ...baseSet,
        documents: [{ ...firstDoc(baseSet), restrictions: { cost: { maxCostMicroUsd: "1.5" } } }],
      }),
    ).rejects.toBeInstanceOf(PlatformError);
    expect(await authority.current()).toBeNull();
  });

  test("concurrent identical publishes converge to one publication", async () => {
    const { authority } = await world();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => authority.publish(structuredClone(baseSet))),
    );
    expect(outcomes.filter((o) => o.status === "published")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "converged")).toHaveLength(7);
  });
});

describe("policy authority: deny-by-default", () => {
  test("with NO configured set every admission fails closed", async () => {
    const { authority } = await world();
    const result = await authority.admit({ context: CTX });
    expect(result.allowed).toBe(false);
    expect(result.denial?.kind).toBe("no-policy-set");
    expect(result.evidence).toBeUndefined();
    const dispatch = await authority.admitDispatch({ context: CTX, facts: { provider: "rail-a" } });
    expect(dispatch.allowed).toBe(false);
  });
});

describe("policy authority: admission (authorize seam)", () => {
  test("an allow carries complete durable admission evidence", async () => {
    const { authority } = await world(baseSet);
    const result = await authority.admit({ context: CTX, facts: { maxCostMicroUsd: "500" } });
    expect(result.allowed).toBe(true);
    expect(result.evidence).toEqual({
      policySetId: "default",
      policySetVersion: 1,
      policyContentHash: expectedHash(baseSet),
      restrictionSetDigest: nodePolicyHasher.sha256Hex(
        canonicalPolicyJson(baseSet.documents[0]?.restrictions),
      ),
    });
    expect(result.effective?.cost?.maxCostMicroUsd).toBe("1000");
  });

  test("requested cost above the effective ceiling denies with typed dimension", async () => {
    const { authority } = await world(baseSet);
    const result = await authority.admit({ context: CTX, facts: { maxCostMicroUsd: "2000" } });
    expect(result.allowed).toBe(false);
    expect(result.denial).toMatchObject({ kind: "restriction", dimension: "cost" });
    expect(result.evidence).toBeDefined(); // evidence present on denials too
  });

  test("requested latency above the ceiling denies", async () => {
    const { authority } = await world(baseSet);
    const result = await authority.admit({ context: CTX, facts: { maxLatencyMs: 9000 } });
    expect(result.allowed).toBe(false);
    expect(result.denial?.dimension).toBe("latency");
  });

  test("a weakening configuration denies at RESOLUTION time (fail closed)", async () => {
    const weakened: PolicySet = {
      id: "default",
      version: 1,
      documents: [
        { scope: "platform", selector: {}, restrictions: { cost: { maxCostMicroUsd: "500" } } },
        {
          scope: "application",
          selector: { tenantId: TENANT, applicationId: APP },
          restrictions: { cost: { maxCostMicroUsd: "5000" } }, // WEAKENING
        },
      ],
    };
    const { authority } = await world(weakened);
    const result = await authority.admit({ context: CTX });
    expect(result.allowed).toBe(false);
    expect(result.denial?.kind).toBe("weakening");
  });

  test("a deny document denies admission with its reason", async () => {
    const suspending: PolicySet = {
      id: "default",
      version: 1,
      documents: [
        {
          scope: "application",
          selector: { tenantId: TENANT, applicationId: APP },
          deny: { reason: "application suspended for non-payment" },
        },
      ],
    };
    const { authority } = await world(suspending);
    const result = await authority.admit({ context: CTX });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("application suspended");
  });
});

describe("policy authority: dispatch admission (provider/tool/agent/sandbox/secret facts)", () => {
  test("provider on the allowlist is allowed; off it or denied is not", async () => {
    const { authority } = await world(baseSet);
    expect(
      (await authority.admitDispatch({ context: CTX, facts: { provider: "rail-a" } })).allowed,
    ).toBe(true);
    const offList = await authority.admitDispatch({
      context: CTX,
      facts: { provider: "unknown-rail" },
    });
    expect(offList.allowed).toBe(false);
    expect(offList.denial?.dimension).toBe("providerModel");
  });

  test("a denied model is rejected even when the provider is allowed", async () => {
    const withDeniedModel: PolicySet = {
      ...baseSet,
      documents: [
        {
          ...firstDoc(baseSet),
          restrictions: {
            ...firstDoc(baseSet).restrictions,
            providerModel: {
              allowedProviders: ["rail-a"],
              deniedModels: ["expensive-model"],
            },
          },
        },
      ],
    };
    const { authority } = await world(withDeniedModel);
    const denied = await authority.admitDispatch({
      context: CTX,
      facts: { provider: "rail-a", model: "expensive-model" },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.denial?.dimension).toBe("providerModel");
    const allowed = await authority.admitDispatch({
      context: CTX,
      facts: { provider: "rail-a", model: "cheap-model" },
    });
    expect(allowed.allowed).toBe(true);
  });

  test("denied tools, hosts, secret refs and ladder violations deny dispatch", async () => {
    const { authority } = await world(baseSet);
    const cases = [
      { facts: { tool: "terminal" }, dimension: "tool" },
      { facts: { host: "api.example" }, dimension: undefined, allowed: true },
      { facts: { host: "evil.example" }, dimension: "network" },
      { facts: { host: "unknown.example" }, dimension: "network" }, // allowlist miss
      { facts: { secretRef: "conn-1" }, dimension: undefined, allowed: true },
      { facts: { secretRef: "conn-2" }, dimension: "secrets" },
      { facts: { autonomy: "unconstrained" as const }, dimension: "autonomy" },
      { facts: { isolation: "none" as const }, dimension: "isolation" },
    ];
    for (const c of cases) {
      const result = await authority.admitDispatch({
        context: CTX,
        facts: { ...c.facts } as Parameters<typeof authority.admitDispatch>[0]["facts"],
      });
      if (c.allowed === true) {
        expect(result.allowed, JSON.stringify(c.facts)).toBe(true);
      } else {
        expect(result.allowed, JSON.stringify(c.facts)).toBe(false);
        expect(result.denial?.dimension, JSON.stringify(c.facts)).toBe(c.dimension);
      }
    }
  });

  test("a task-scoped tightening changes the dispatch decision for that task only", async () => {
    const set: PolicySet = {
      ...baseSet,
      documents: [
        ...baseSet.documents,
        {
          scope: "task",
          selector: { taskKind: "summarize" },
          restrictions: { network: { egress: "none" } },
        },
      ],
    };
    const { authority } = await world(set);
    const forTask = await authority.admitDispatch({
      context: CTX,
      facts: { host: "api.example" },
    });
    expect(forTask.allowed).toBe(false); // task scope tightened egress to none
    const otherTask = await authority.admitDispatch({
      context: { ...CTX, taskKind: "translate" },
      facts: { host: "api.example" },
    });
    expect(otherTask.allowed).toBe(true);
  });
});

describe("policy authority: evidence stability", () => {
  test("the same effective set always yields the same restriction digest", async () => {
    const { authority } = await world(baseSet);
    const first = await authority.admit({ context: CTX });
    const second = await authority.admit({ context: CTX });
    expect(first.evidence?.restrictionSetDigest).toBe(second.evidence?.restrictionSetDigest);
    expect(first.evidence?.policyContentHash).toBe(expectedHash(baseSet));
  });

  test("a new version changes the evidence identity", async () => {
    const { authority } = await world(baseSet);
    const v1 = await authority.admit({ context: CTX });
    await authority.publish({ ...baseSet, version: 2 });
    const v2 = await authority.admit({ context: CTX });
    expect(v1.evidence?.policySetVersion).toBe(1);
    expect(v2.evidence?.policySetVersion).toBe(2);
    expect(v1.evidence?.policyContentHash).not.toBe(v2.evidence?.policyContentHash);
  });
});
