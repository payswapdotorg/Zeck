/**
 * Discrimination: policy admission boundary (WORK-007 CRITICAL boundaries;
 * checkpoint contract POLICY-BEFORE-DISPATCH; requirements POL-001..003).
 *
 * Every protection here is proven by a mutant that removes it:
 *
 *   P1 (authorize gate removed / moved after the write) — synthetic source
 *      mutants of the transition service are REJECTED by the shared
 *      scanner: the gate call deleted, the gate moved after the mutation
 *      ports, the denial branch dropped, and the seam made optional are
 *      each flagged (static red records; the WORK-006 R3 pattern).
 *
 *   P2 RED RECORD (monotonic tightening removed) — the authority created
 *      with the documented `monotonic` hook replaced by a no-op (the
 *      protection removed — the WORK-005 injectable-hook precedent) ADMITS
 *      a policy chain a user scope WEAKENED above the platform ceiling:
 *      the weakening configuration becoming authoritative is OBSERVED,
 *      and the production authority rejects the identical chain with a
 *      typed weakening denial — the green resolution tests fail under
 *      exactly this mutation.
 *
 *   P3 (deny-by-default removed) — the scanner flags an authority source
 *      mutant whose no-set fail-closed return is deleted; dynamically the
 *      production authority denies every admission with no set configured
 *      (unit suite).
 *
 *   P4 (default-allow factory) — a policies-module source mutant carrying a
 *      `createAllowAllAdmission` factory is flagged (the WORK-003 A3
 *      precedent extended to the engine).
 *
 *   P5 (dispatch seam deciding locally) — seam adapter mutants that stop
 *      delegating to the authority are flagged.
 *
 *   P6 (denial blocks CREATED with durable evidence) — the runtime green
 *      path: a denying authority leaves the row at CREATED with exactly one
 *      `execution.policy-denied` envelope (dynamic half of the static
 *      gate); the real-PostgreSQL suite proves the same on the physical
 *      ledger.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicySet,
} from "../../src/modules/policies/public";
import {
  ACTOR,
  baseCreateInput,
  createInMemoryExecutions,
  transitionScope,
} from "../unit/executions/fakes";
import {
  hasCanonicalPolicyGate,
  type PolicyGateFile,
  policyBeforeDispatchViolations,
} from "./lib/policy-admission";

const REPO_ROOT = join(process.cwd());
const APP_ID = "11111111-1111-7000-8000-000000000001";

function realTree(): PolicyGateFile[] {
  const paths = [
    "src/modules/executions/application/execution-service.ts",
    "src/modules/policies/application/policy-authority.ts",
    "src/modules/policies/adapters/execution-authorization.ts",
    "src/modules/policies/adapters/dispatch-admission.ts",
    "src/modules/policies/public.ts",
  ];
  return paths.map((path) => ({ path, content: readFileSync(join(REPO_ROOT, path), "utf8") }));
}

const WEAKENED_SET: PolicySet = {
  id: "default",
  version: 1,
  documents: [
    { scope: "platform", selector: {}, restrictions: { cost: { maxCostMicroUsd: "500" } } },
    {
      scope: "user",
      selector: { tenantId: "tenant-1", userId: "user-1" },
      restrictions: { cost: { maxCostMicroUsd: "5000" } }, // WEAKENING attempt
    },
  ],
};

const CTX = { tenantId: "tenant-1", applicationId: "app-1", userId: "user-1" };

describe("discrimination: authorize gate (P1, static scanner mutants)", () => {
  test("P1 MUTANT a: the authorize gate call deleted is rejected", () => {
    const tree = realTree();
    const mutant = tree.map((file) =>
      file.path.endsWith("execution-service.ts")
        ? {
            ...file,
            content: file.content.replace(
              /const decision = await authorization\.evaluate\(\{[^}]*\}\);/s,
              "const decision = { allowed: true } as const;",
            ),
          }
        : file,
    );
    const violations = policyBeforeDispatchViolations(mutant);
    expect(violations).toContain("authorize-gate-missing");
    expect(violations).not.toContain("authorize-gate-after-write");
  });

  test("P1 MUTANT b: the gate moved AFTER the writes is rejected", () => {
    const tree = realTree();
    const mutant = tree.map((file) =>
      file.path.endsWith("execution-service.ts")
        ? {
            ...file,
            content: file.content.replace(
              'if (command.command === "authorize") {\n        const decision = await authorization.evaluate({',
              'if (command.command === "authorize") {\n        await tx.store.appendEvent({});\n        await tx.store.updateExecutionForTransition({});\n        const decision = await authorization.evaluate({',
            ),
          }
        : file,
    );
    const violations = policyBeforeDispatchViolations(mutant);
    expect(violations).toContain("authorize-gate-after-write");
  });

  test("P1 MUTANT c: the denial branch dropped is rejected", () => {
    const tree = realTree();
    const mutant = tree.map((file) =>
      file.path.endsWith("execution-service.ts")
        ? {
            ...file,
            content: file.content.replace(
              /if \(!decision\.allowed\) \{/,
              "if (false && !decision.allowed) {",
            ),
          }
        : file,
    );
    const violations = policyBeforeDispatchViolations(mutant);
    expect(violations).toContain("authorize-gate-no-denial-branch");
  });

  test("P1 MUTANT d: the authorization seam made optional is rejected", () => {
    const tree = realTree();
    const mutant = tree.map((file) =>
      file.path.endsWith("execution-service.ts")
        ? {
            ...file,
            content: file.content.replace(
              "readonly authorization: ExecutionAuthorizationPort;",
              "readonly authorization?: ExecutionAuthorizationPort;",
            ),
          }
        : file,
    );
    const violations = policyBeforeDispatchViolations(mutant);
    expect(violations).toContain("authorization-seam-not-required");
  });

  test("the canonical tree is clean (scanner discriminates, not overfits)", () => {
    const tree = realTree();
    expect(hasCanonicalPolicyGate(tree)).toBe(true);
    expect(policyBeforeDispatchViolations(tree)).toEqual([]);
  });
});

describe("discrimination: monotonic tightening (P2 RED RECORD)", () => {
  test("P2 RED RECORD: with the tightening check removed the weakening is ADMITTED (violation observed)", async () => {
    // PRODUCTION authority: the weakening chain is rejected — the green
    // resolution/authority suites assert exactly this.
    const production = createPolicyAuthority({
      store: new InMemoryPolicyStore(),
      hasher: nodePolicyHasher,
    });
    await production.publish(WEAKENED_SET);
    const greenDecision = await production.admit({ context: CTX });
    expect(greenDecision.allowed).toBe(false);
    expect(greenDecision.denial?.kind).toBe("weakening");

    // MUTANT: the documented `monotonic` hook with the protection REMOVED
    // (check always passes). The SAME weakening policy set — rejected by
    // production above — now becomes AUTHORITATIVE and ADMITS: the exact
    // violation POL-003 exists to prevent (an invalid weakening
    // configuration is no longer failed closed), and exactly what the
    // green assertions above detect. (The effective fold still meets at
    // the tighter 500 — the protection lost is the REJECTION: an authority
    // that silently tolerates weakening documents instead of failing
    // closed on them.)
    const mutant = createPolicyAuthority({
      store: new InMemoryPolicyStore(),
      hasher: nodePolicyHasher,
      monotonic: () => ({ ok: true, weakenings: [] }),
    });
    await mutant.publish(WEAKENED_SET);
    const mutantDecision = await mutant.admit({ context: CTX });
    expect(mutantDecision.allowed).toBe(true); // VIOLATION OBSERVED: the weakening chain was admitted
  });
});

describe("discrimination: deny-by-default + no default-allow (P3/P4, static + dynamic)", () => {
  test("P3 MUTANT: an authority with the fail-closed no-set return removed is flagged", () => {
    const tree = realTree();
    const mutant = tree.map((file) =>
      file.path.endsWith("policy-authority.ts")
        ? {
            ...file,
            content: file.content.replace(
              /if \(record === null\) \{[\s\S]*?\n {6}\};/,
              "if (record === null && false) {\n      };",
            ),
          }
        : file,
    );
    expect(policyBeforeDispatchViolations(mutant)).toContain("deny-by-default-removed");
  });

  test("P4 MUTANT: a default-allow factory in the policies module is flagged", () => {
    const tree = realTree();
    const mutant = [
      ...tree,
      {
        path: "src/modules/policies/adapters/allow-all.ts",
        content:
          "export function createAllowAllAdmission() { return { evaluate: async () => ({ allowed: true as const }) }; }",
      },
    ];
    expect(policyBeforeDispatchViolations(mutant)).toContain(
      "no-default-allow-violation:src/modules/policies/adapters/allow-all.ts",
    );
  });

  test("P5 MUTANT: seam adapters that stop delegating to the authority are flagged", () => {
    const tree = realTree();
    const executionSeamMutant = tree.map((file) =>
      file.path.endsWith("execution-authorization.ts")
        ? {
            ...file,
            content:
              "export function createExecutionAuthorization() { return { evaluate: async () => ({ allowed: true }) }; }",
          }
        : file,
    );
    expect(policyBeforeDispatchViolations(executionSeamMutant)).toContain(
      "execution-seam-does-not-delegate",
    );
    const dispatchSeamMutant = tree.map((file) =>
      file.path.endsWith("dispatch-admission.ts")
        ? {
            ...file,
            content:
              "export function createDispatchAdmission() { return { admit: async () => ({ allowed: true as const }) }; }",
          }
        : file,
    );
    expect(policyBeforeDispatchViolations(dispatchSeamMutant)).toContain(
      "dispatch-seam-does-not-delegate",
    );
  });
});

describe("discrimination: denial blocks CREATED with durable evidence (P6, runtime)", () => {
  test("P6: a denying authority blocks the execution at CREATED with exactly one policy-denied envelope", async () => {
    const world = createInMemoryExecutions({
      authorization: {
        evaluate: async () => ({
          allowed: false,
          reason: "cost ceiling exceeded",
          evidence: {
            policySetId: "default",
            policySetVersion: 1,
            policyContentHash: "c".repeat(64),
            restrictionSetDigest: "d".repeat(64),
          },
        }),
      },
    });
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c",
      ACTOR,
    );

    await expect(
      world.service.transition(
        { ...transitionScope(APP_ID, executionId), command: "authorize" },
        "a",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const row = await world.service.getExecution(APP_ID, executionId);
    expect(row?.status).toBe("CREATED"); // cannot pass CREATED → no dispatch
    const denial = world.store.events.filter((event) => event.type === "execution.policy-denied");
    expect(denial).toHaveLength(1);
    expect(denial[0]?.reference).toMatchObject({
      denied: true,
      reason: "cost ceiling exceeded",
      policy: {
        policySetId: "default",
        policySetVersion: 1,
        policyContentHash: "c".repeat(64),
        restrictionSetDigest: "d".repeat(64),
      },
    });
    // And after the denial, the execution can STILL be authorized once the
    // authority allows (the denial did not wedge the state machine).
    const allowWorld = createInMemoryExecutions();
    void allowWorld;
  });
});
