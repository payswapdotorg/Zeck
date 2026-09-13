/**
 * VAL-024 acceptance criterion 1: the tenant-isolation customer
 * application rides the public SDK boundary end to end against a
 * controlled fake tenant-aware API (submission → the app-side probe →
 * async completion → result retrieval → deterministic assertions →
 * recorder-consumable evidence), and its pinned task slice matches
 * the repository configuration file and the corpus. Discrimination:
 * every denied row PASSES on the honest COMPLETED outcome (the typed
 * boundary verified); a LEAKY fake that discloses the other tenant's
 * row on a cross-tenant read FAILS the app's assertions (a fabricated
 * boundary is never tolerated — the canary content must never reach
 * the app's evidence); a FAILED platform outcome fails every row.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  runTenantIsolationApp,
  TENANT_ISOLATION_TASKS,
  type TenantIsolationWorldRefs,
} from "../../../benchmarks/validation/apps/tenant-isolation/application";
import { ISOLATION_CORPUS } from "../../../benchmarks/validation/apps/tenant-isolation/corpus";
import {
  createFakeApiWorld,
  FIXTURE_FOREIGN_APPLICATION_ID,
  FIXTURE_FOREIGN_ARTIFACT_DIGEST,
  FIXTURE_FOREIGN_ENVIRONMENT_ID,
  FIXTURE_FOREIGN_EXECUTION_ID,
  FIXTURE_FOREIGN_MARKERS,
  FIXTURE_OWN_ARTIFACT_DIGEST,
} from "../../../benchmarks/validation/apps/tenant-isolation/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";

const REVISION = "fefb52f736b20e852b040c8cedc025fbc693171a";

const WORLD_REFS: TenantIsolationWorldRefs = {
  foreignApplicationId: FIXTURE_FOREIGN_APPLICATION_ID,
  foreignEnvironmentId: FIXTURE_FOREIGN_ENVIRONMENT_ID,
  foreignExecutionId: FIXTURE_FOREIGN_EXECUTION_ID,
  foreignArtifactDigest: FIXTURE_FOREIGN_ARTIFACT_DIGEST,
  ownArtifactDigest: FIXTURE_OWN_ARTIFACT_DIGEST,
  foreignMarkers: FIXTURE_FOREIGN_MARKERS,
};

const baseConfig = {
  applicationId: "app-fixture-own",
  baseUrl: "http://fake-zeck.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  pollIntervalMs: 1,
  completionTimeoutMs: 5_000,
};

async function runAppOverFakeWorld(options: {
  readonly leaky?: boolean;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly taskIndex: number;
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly foreignReads: number;
}> {
  const { transport, state } = createFakeApiWorld({
    ...(options.leaky === true ? { leaky: true } : {}),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
  });
  const outcome = await runTenantIsolationApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport,
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
    worldRefs: WORLD_REFS,
  });
  return { evidence: outcome.evidence, passed: outcome.passed, foreignReads: state.foreignReads };
}

describe("VAL-024 tenant-isolation application (public SDK boundary)", () => {
  test("the task slice mirrors the corpus exactly (kind, scenario, family, targetRole, terminal)", () => {
    expect(TENANT_ISOLATION_TASKS.length).toBe(ISOLATION_CORPUS.length);
    for (const [index, task] of TENANT_ISOLATION_TASKS.entries()) {
      const row = ISOLATION_CORPUS[index];
      if (row === undefined) throw new Error("missing corpus row");
      expect(task.kind).toBe("isolation-probe");
      expect(task.scenario).toBe(row.rowId);
      expect(task.family).toBe(row.family);
      expect(task.targetRole).toBe(row.targetRole);
      expect(task.expectedTerminal).toBe(row.expected.terminal);
    }
  });

  test("the corpus rows are well-formed (unique ids, declared probes, expected rejections in vocabulary)", () => {
    const ids = ISOLATION_CORPUS.map((row) => row.rowId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of ISOLATION_CORPUS) {
      expect(row.platformProbes.length).toBeGreaterThan(0);
      expect(row.expected.observations.length).toBe(row.platformProbes.length);
      expect(row.expected.appObservations.length).toBe(row.appProbe === undefined ? 0 : 1);
      expect(row.expected.terminal).toBe("COMPLETED");
      for (const observation of row.expected.observations) {
        if (observation.kind === "denied" || observation.kind === "miss") {
          expect(
            observation.rejection,
            `${row.rowId} denial needs a typed rejection`,
          ).not.toBeNull();
        }
        if (observation.kind === "miss") {
          expect(observation.rejection).toBe("SCOPE_CHECKED_MISS");
        }
        if (observation.kind === "granted") {
          expect(observation.rejection).toBeNull();
        }
      }
      for (const observation of row.expected.appObservations) {
        if (observation.kind === "denied") {
          expect(
            observation.rejection,
            `${row.rowId} app denial needs a typed rejection`,
          ).not.toBeNull();
        }
      }
    }
  });

  test("the repository config.json mirrors the pinned task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(process.cwd(), "benchmarks/validation/apps/tenant-isolation/config.json"),
        "utf8",
      ),
    ) as {
      tasks: {
        kind: string;
        scenario: string;
        family: string;
        targetRole: string;
        expectedTerminal: string;
      }[];
    };
    expect(config.tasks.length).toBe(TENANT_ISOLATION_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const pinned = TENANT_ISOLATION_TASKS[index];
      if (pinned === undefined) throw new Error("missing pinned task");
      expect(task.kind).toBe(pinned.kind);
      expect(task.scenario).toBe(pinned.scenario);
      expect(task.family).toBe(pinned.family);
      expect(task.targetRole).toBe(pinned.targetRole);
      expect(task.expectedTerminal).toBe(pinned.expectedTerminal);
    }
  });

  test("every corpus row PASSES on the honest denied boundary with valid evidence", async () => {
    for (const [index, row] of ISOLATION_CORPUS.entries()) {
      const outcome = await runAppOverFakeWorld({ taskIndex: index });
      expect(outcome.passed, `${row.rowId} should pass on the verified boundary`).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  });

  test("the app-side probe actually fired (the foreign read was attempted, honestly denied)", async () => {
    const readIndex = ISOLATION_CORPUS.findIndex((row) => row.rowId === "cross-tenant-read");
    if (readIndex < 0) throw new Error("missing read row");
    const outcome = await runAppOverFakeWorld({ taskIndex: readIndex });
    expect(outcome.passed).toBe(true);
    expect(outcome.foreignReads).toBe(1);
  });

  test("a LEAKY fake that discloses the foreign row FAILS the app (the boundary is never fabricated)", async () => {
    const readIndex = ISOLATION_CORPUS.findIndex((row) => row.rowId === "cross-tenant-read");
    if (readIndex < 0) throw new Error("missing read row");
    const outcome = await runAppOverFakeWorld({ leaky: true, taskIndex: readIndex });
    expect(outcome.passed).toBe(false);
  });

  test("the other tenant's canary content never appears in the app's evidence", async () => {
    const readIndex = ISOLATION_CORPUS.findIndex((row) => row.rowId === "cross-tenant-read");
    if (readIndex < 0) throw new Error("missing read row");
    const outcome = await runAppOverFakeWorld({ leaky: true, taskIndex: readIndex });
    const evidenceText = JSON.stringify(outcome.evidence);
    for (const marker of FIXTURE_FOREIGN_MARKERS) {
      expect(evidenceText).not.toContain(marker.marker);
    }
  });

  test("a FAILED platform outcome fails the row (the app never passes a failed execution)", async () => {
    // The honest FAILED terminal (a platform-side disclosure or criteria
    // failure would produce it) fails the app's outcome contract: the
    // forbidden-terminal assertion observes FAILED on a row that pins
    // COMPLETED.
    const readIndex = ISOLATION_CORPUS.findIndex((row) => row.rowId === "cross-tenant-read");
    if (readIndex < 0) throw new Error("missing read row");
    const outcome = await runAppOverFakeWorld({ terminal: "FAILED", taskIndex: readIndex });
    expect(outcome.passed).toBe(false);
  });
});
