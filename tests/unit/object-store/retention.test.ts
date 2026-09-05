/**
 * Unit tests — the artifact byte retention/cleanup contract
 * (WORK-043 / D-02, AC7).
 *
 * Proves the safety envelope: candidates outside the namespace are
 * REFUSED (authoritative metadata and non-artifact keys are never
 * deletable); content-addressed key shape is enforced; keys retained
 * by the authoritative ledger are never deleted; an UNCONFIRMED or
 * empty inventory refuses every deletion (a failed read never
 * authorizes a sweep); execution is dry-run by default; per-key
 * failures are reported (no silent success); and the sweep only ever
 * deletes explicitly planned keys.
 */
import { describe, expect, test } from "vitest";
import type {
  ObjectStorePort,
  PutOptions,
  StoredObject,
} from "../../../src/platform/object-store/port";
import {
  DEFAULT_ARTIFACT_NAMESPACE,
  executeRetentionSweep,
  planRetentionSweep,
  RetentionSafetyError,
  type RetentionSweepInput,
} from "../../../src/platform/object-store/retention";

const KEY_A = "zeck/artifacts/tenant-a/ab/".concat("a".repeat(64));
const KEY_B = "zeck/artifacts/tenant-b/cd/".concat("b".repeat(64));
const KEY_C = "zeck/artifacts/tenant-c/ef/".concat("c".repeat(64));

function input(overrides: Partial<RetentionSweepInput>): RetentionSweepInput {
  return {
    namespace: DEFAULT_ARTIFACT_NAMESPACE,
    authoritativeRetainedKeys: new Set([KEY_B]),
    candidateKeys: [KEY_A, KEY_C],
    authoritativeInventoryConfirmed: true,
    ...overrides,
  };
}

function fakeStore(options: { failOn?: string } = {}): {
  store: ObjectStorePort;
  deletes: string[];
} {
  const deletes: string[] = [];
  return {
    deletes,
    store: {
      put: async (_key: string, _body: Uint8Array, _options?: PutOptions) => undefined,
      get: async (_key: string): Promise<StoredObject | null> => null,
      delete: async (key: string) => {
        if (options.failOn === key) {
          throw new Error("provider delete failed (403)");
        }
        deletes.push(key);
      },
    },
  };
}

describe("retention sweep planning (pure, no store access)", () => {
  test("plans exactly the unretained, in-namespace, well-shaped candidates", () => {
    const plan = planRetentionSweep(input({}));
    expect(plan.deletions).toEqual([KEY_A, KEY_C]);
    expect(plan.refusals).toHaveLength(0);
  });

  test("keys outside the namespace are refused — metadata and foreign keys are untouchable", () => {
    const plan = planRetentionSweep(
      input({
        candidateKeys: ["postgres/authoritative/table", "other-bucket/key", "zeck/artifacts"],
      }),
    );
    expect(plan.deletions).toEqual([]);
    expect(plan.refusals.map((refusal) => refusal.key)).toEqual([
      "postgres/authoritative/table",
      "other-bucket/key",
      "zeck/artifacts",
    ]);
    expect(plan.refusals[0]?.reason).toContain("outside the retention namespace");
  });

  test("non-content-addressed keys inside the namespace are refused", () => {
    const plan = planRetentionSweep(
      input({ candidateKeys: ["zeck/artifacts/tenant-a/zz/not-a-digest"] }),
    );
    expect(plan.deletions).toEqual([]);
    expect(plan.refusals[0]?.reason).toContain("key shape");
  });

  test("retained keys are never deletable (the authoritative ledger wins)", () => {
    const plan = planRetentionSweep(input({ candidateKeys: [KEY_B, KEY_A] }));
    expect(plan.deletions).toEqual([KEY_A]);
    expect(plan.refusals).toHaveLength(1);
    expect(plan.refusals[0]?.key).toBe(KEY_B);
    expect(plan.refusals[0]?.reason).toContain("retained by the authoritative ledger");
  });

  test("an UNCONFIRMED inventory refuses every deletion (fail closed)", () => {
    const plan = planRetentionSweep(input({ authoritativeInventoryConfirmed: false }));
    expect(plan.deletions).toEqual([]);
    expect(plan.refusals).toHaveLength(2);
    expect(plan.refusals.every((refusal) => refusal.reason.includes("not confirmed"))).toBe(true);
  });

  test("an empty confirmed inventory with candidates still plans them (explicit garbage collection)", () => {
    const plan = planRetentionSweep(
      input({ authoritativeRetainedKeys: new Set(), authoritativeInventoryConfirmed: true }),
    );
    expect(plan.deletions).toEqual([KEY_A, KEY_C]);
  });

  test("an empty UNCONFIRMED inventory with candidates refuses them", () => {
    const plan = planRetentionSweep(
      input({
        authoritativeRetainedKeys: new Set(),
        authoritativeInventoryConfirmed: false,
      }),
    );
    expect(plan.deletions).toEqual([]);
    expect(plan.refusals).toHaveLength(2);
  });

  test("a broken namespace (empty prefix / uncompilable pattern) fails closed", () => {
    expect(() =>
      planRetentionSweep(input({ namespace: { prefix: "", keyPattern: ".*" } })),
    ).toThrow(RetentionSafetyError);
    expect(() =>
      planRetentionSweep(input({ namespace: { prefix: "zeck/", keyPattern: "(" } })),
    ).toThrow(RetentionSafetyError);
  });
});

describe("retention sweep execution (bounded, dry-run default)", () => {
  test("dry-run (the default) plans but never deletes", async () => {
    const { store, deletes } = fakeStore();
    const outcome = await executeRetentionSweep(store, input({}));
    expect(outcome.dryRun).toBe(true);
    expect(outcome.plannedDeletions).toEqual([KEY_A, KEY_C]);
    expect(outcome.deleted).toEqual([]);
    expect(deletes).toHaveLength(0);
  });

  test("execution deletes exactly the planned keys", async () => {
    const { store, deletes } = fakeStore();
    const outcome = await executeRetentionSweep(store, input({}), { dryRun: false });
    expect(outcome.dryRun).toBe(false);
    expect(outcome.deleted).toEqual([KEY_A, KEY_C]);
    expect(deletes).toEqual([KEY_A, KEY_C]);
    expect(outcome.failures).toEqual([]);
  });

  test("deletion failures are reported per key — no silent success", async () => {
    const { store, deletes } = fakeStore({ failOn: KEY_A });
    const outcome = await executeRetentionSweep(store, input({}), { dryRun: false });
    expect(outcome.deleted).toEqual([KEY_C]);
    expect(outcome.failures).toEqual([{ key: KEY_A, error: "provider delete failed (403)" }]);
    expect(deletes).toEqual([KEY_C]);
  });

  test("refused candidates never reach the store", async () => {
    const { store, deletes } = fakeStore();
    const outcome = await executeRetentionSweep(
      store,
      input({ candidateKeys: [KEY_B, "foreign/key"], authoritativeInventoryConfirmed: true }),
      { dryRun: false },
    );
    expect(outcome.deleted).toEqual([]);
    expect(deletes).toHaveLength(0);
    expect(outcome.refusals).toHaveLength(2);
  });
});
