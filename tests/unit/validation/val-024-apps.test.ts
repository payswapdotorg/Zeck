/**
 * VAL-024 acceptance criterion 1: the tenant-isolation customer
 * application rides the public SDK boundary end to end against a
 * controlled fake transport (its own cross-tenant access attempts →
 * the typed rejections → the carrier submission → async completion →
 * result retrieval → deterministic assertions → recorder-consumable
 * evidence), and its pinned task slice matches the repository
 * configuration file and the corpus. Discrimination: a FAILED
 * platform outcome fails every row's assertions (the application
 * never passes a failed execution — an admitted probe or a leaked
 * disclosure is an honest finding, never a fabricated isolation), and
 * every row's wire probes are denied with the pinned typed codes.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  runTenantIsolationApp,
  type SdkProbeOutcome,
  TENANT_ISOLATION_TASKS,
} from "../../../benchmarks/validation/apps/tenant-isolation/application";
import { TENANT_ISOLATION_CORPUS } from "../../../benchmarks/validation/apps/tenant-isolation/corpus";
import {
  createFakeApiWorld,
  fixedForeignRefs,
} from "../../../benchmarks/validation/apps/tenant-isolation/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "ea1550ac6feb506701b3eddf5636cf2082c0c38d";

const baseConfig = {
  applicationId: "11111111-1111-7111-8111-111111111111",
  baseUrl: "http://fake-zeck.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  pollIntervalMs: 1,
  completionTimeoutMs: 5_000,
};

async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly apiMutations?: {
    readonly leakForeignReads?: boolean;
    readonly admitForgedScope?: boolean;
    readonly admitForeignEnvironment?: boolean;
  };
  readonly carrierTerminal?: "COMPLETED" | "FAILED";
  readonly carrierVerification?: "PASS" | "FAIL";
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly probes: readonly SdkProbeOutcome[];
}> {
  const { transport } = createFakeApiWorld({
    ...(options.apiMutations ?? {}),
    ...(options.carrierTerminal === undefined ? {} : { carrierTerminal: options.carrierTerminal }),
    ...(options.carrierVerification === undefined
      ? {}
      : { carrierVerification: options.carrierVerification }),
  });
  return runTenantIsolationApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport: transport as TransportImplementation,
    now: () => new Date(1_000),
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-024-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
    foreignRefs: fixedForeignRefs(),
  });
}

describe("VAL-024 tenant-isolation application (public SDK boundary)", () => {
  test("the task slice mirrors the corpus exactly (kind, scenario, probe, terminal)", () => {
    expect(TENANT_ISOLATION_TASKS.length).toBe(TENANT_ISOLATION_CORPUS.length);
    for (const [index, task] of TENANT_ISOLATION_TASKS.entries()) {
      const row = TENANT_ISOLATION_CORPUS[index];
      if (row === undefined) throw new Error("missing corpus row");
      expect(task.kind).toBe("isolation-probe");
      expect(task.scenario).toBe(row.rowId);
      expect(task.probe).toBe(row.probe);
      expect(task.expectedTerminal).toBe(row.expected.terminal);
    }
  });

  test("the repository config.json mirrors the pinned task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(process.cwd(), "benchmarks/validation/apps/tenant-isolation/config.json"),
        "utf8",
      ),
    ) as {
      tasks: { kind: string; scenario: string; probe: string; expectedTerminal: string }[];
    };
    expect(config.tasks.length).toBe(TENANT_ISOLATION_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const pinned = TENANT_ISOLATION_TASKS[index];
      if (pinned === undefined) throw new Error("missing pinned task");
      expect(task.kind).toBe(pinned.kind);
      expect(task.scenario).toBe(pinned.scenario);
      expect(task.probe).toBe(pinned.probe);
      expect(task.expectedTerminal).toBe(pinned.expectedTerminal);
    }
  });

  test("every row PASSES on the honest isolation-held COMPLETED outcome with valid evidence", async () => {
    for (const [index, row] of TENANT_ISOLATION_CORPUS.entries()) {
      const outcome = await runAppOverFakeWorld({ taskIndex: index });
      expect(outcome.passed, `${row.rowId} should pass on the isolation-held COMPLETED`).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
      // Every wire probe of the row's own battery was denied with its
      // expected typed rejection and disclosed no foreign content.
      for (const probe of outcome.probes) {
        expect(probe.denied, `${row.rowId}/${probe.probeId} denied`).toBe(true);
        expect(probe.dataLeak, `${row.rowId}/${probe.probeId} leak`).toBe(false);
        expect(probe.requestDigest).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  }, 30_000);

  test("every row's wire probes observe the pinned typed codes and wire statuses", async () => {
    for (const [index, row] of TENANT_ISOLATION_CORPUS.entries()) {
      const outcome = await runAppOverFakeWorld({ taskIndex: index });
      const wirePlanCount = row.expectedRejection.wire === "NOT_APPLICABLE" ? 0 : undefined;
      if (wirePlanCount === 0) {
        expect(outcome.probes.length, `${row.rowId} has no wire probes`).toBe(0);
        continue;
      }
      expect(outcome.probes.length, `${row.rowId} wire probes`).toBeGreaterThan(0);
      for (const probe of outcome.probes) {
        expect(probe.observedCode, `${row.rowId}/${probe.probeId} code`).toBe(probe.expectedCode);
        expect(probe.observedStatus, `${row.rowId}/${probe.probeId} status`).toBe(
          probe.expectedStatus,
        );
      }
    }
  }, 30_000);

  test("a FAILED platform outcome fails every row (the app never passes a failed execution)", async () => {
    for (const [index, row] of TENANT_ISOLATION_CORPUS.entries()) {
      const outcome = await runAppOverFakeWorld({ taskIndex: index, carrierTerminal: "FAILED" });
      expect(outcome.passed, `${row.rowId} should fail on FAILED`).toBe(false);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  }, 30_000);

  test("a completion whose verification carries FAIL statuses fails the row (a violated criterion is never tolerated)", async () => {
    const readIndex = TENANT_ISOLATION_CORPUS.findIndex((row) => row.rowId === "cross-tenant-read");
    if (readIndex < 0) throw new Error("missing read row");
    const outcome = await runAppOverFakeWorld({
      taskIndex: readIndex,
      carrierVerification: "FAIL",
    });
    expect(outcome.passed).toBe(false);
  });

  test("a wire world that LEAKS the foreign execution fails the row (the disclosure is caught mechanically)", async () => {
    const readIndex = TENANT_ISOLATION_CORPUS.findIndex((row) => row.rowId === "cross-tenant-read");
    if (readIndex < 0) throw new Error("missing read row");
    const outcome = await runAppOverFakeWorld({
      taskIndex: readIndex,
      apiMutations: { leakForeignReads: true },
    });
    expect(outcome.passed).toBe(false);
    const leaked = outcome.probes.find((probe) => probe.dataLeak);
    expect(leaked).toBeDefined();
    expect(leaked?.denied).toBe(false);
    // The admission carried the foreign content (an unexpected 200
    // with data) — exactly what the scan hunts (never a silently
    // tolerated disclosure).
    expect(leaked?.observedStatus).toBeNull();
    expect(leaked?.observedCode).toBeNull();
    expect(leaked?.message).toContain("admitted");
  });

  test("a wire world that ADMITS the forged scope fails the row (the header never authorizes)", async () => {
    const forgedIndex = TENANT_ISOLATION_CORPUS.findIndex(
      (row) => row.rowId === "forged-application-scope",
    );
    if (forgedIndex < 0) throw new Error("missing forged row");
    const outcome = await runAppOverFakeWorld({
      taskIndex: forgedIndex,
      apiMutations: { admitForgedScope: true },
    });
    expect(outcome.passed).toBe(false);
    const admitted = outcome.probes.find((probe) => !probe.denied);
    expect(admitted).toBeDefined();
    expect(admitted?.dataLeak).toBe(true);
  });

  test("a wire world that ADMITS the foreign-environment create fails the row (the typed violation is load-bearing)", async () => {
    const envIndex = TENANT_ISOLATION_CORPUS.findIndex(
      (row) => row.rowId === "cross-tenant-environment-create",
    );
    if (envIndex < 0) throw new Error("missing env row");
    const outcome = await runAppOverFakeWorld({
      taskIndex: envIndex,
      apiMutations: { admitForeignEnvironment: true },
    });
    expect(outcome.passed).toBe(false);
    const admitted = outcome.probes.find((probe) => !probe.denied);
    expect(admitted).toBeDefined();
  });

  test("an empty task slice index is rejected (the pinned slice is load-bearing)", async () => {
    await expect(runAppOverFakeWorld({ taskIndex: 99 })).rejects.toThrow(
      "the pinned tenant-isolation task slice is empty",
    );
  });
});
