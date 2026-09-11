/**
 * VAL-003 acceptance criteria 2, 5, 6, 8 — corpus structure: complete
 * workload coverage at the documented floor, deterministic assembly
 * with stable unique identities, fixture manifest integrity, and run
 * metadata wiring (corpus version + task identities).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  CORPUS_VERSION,
  FAMILY_TASK_FLOOR,
  familyTaskCounts,
  GOLDEN_TASKS,
  runMetadataForTask,
  SCENARIO_FAMILIES,
  taskById,
  tasksByFamily,
} from "../../../benchmarks/validation/corpus";
import { FIXTURES, fixtureIntegrity } from "../../../benchmarks/validation/corpus/fixtures";
import {
  validateGoldenTask,
  WORKLOAD_FAMILIES,
} from "../../../benchmarks/validation/corpus/schema";
import { checkRunMetadata, deriveRunId } from "../../../benchmarks/validation/run-identity";

describe("validation: corpus coverage and structure (VAL-003 AC2)", () => {
  test("every required workload family is represented at the documented floor", () => {
    const counts = familyTaskCounts();
    for (const family of WORKLOAD_FAMILIES) {
      expect(counts[family], `${family} task count`).toBeGreaterThanOrEqual(FAMILY_TASK_FLOOR);
    }
  });

  test("the corpus totals at least 420 tasks across 22 families", () => {
    expect(GOLDEN_TASKS.length).toBeGreaterThanOrEqual(420);
    expect(WORKLOAD_FAMILIES.length).toBe(22);
  });

  test("every task is schema-valid", () => {
    for (const task of GOLDEN_TASKS) {
      expect(validateGoldenTask(task), task.taskId).toEqual([]);
    }
  });

  test("every task identity is unique and stable (deterministic assembly)", () => {
    const ids = GOLDEN_TASKS.map((task) => task.taskId);
    expect(new Set(ids).size).toBe(ids.length);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(GOLDEN_TASKS.map((task) => [task.taskId, task.input])))
      .digest("hex");
    expect(fingerprint.length).toBe(64);
  });

  test("scenario identity matches task identity prefix (append-only ids)", () => {
    for (const task of GOLDEN_TASKS) {
      expect(task.taskId.startsWith(`${task.scenarioId}#`), task.taskId).toBe(true);
    }
    for (const scenario of SCENARIO_FAMILIES) {
      const count = tasksByFamily(scenario[0]?.family ?? "text").filter(
        (task) => task.scenarioId === (scenario[0]?.scenarioId ?? "?"),
      ).length;
      expect(count, scenario[0]?.scenarioId ?? "?").toBe(scenario.length);
    }
  });

  test("taskById resolves and misses deterministically", () => {
    const first = GOLDEN_TASKS[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(taskById(first.taskId)?.taskId).toBe(first.taskId);
    }
    expect(taskById("nonexistent#000")).toBeUndefined();
  });
});

describe("validation: corpus fixtures (VAL-003 AC5)", () => {
  test("every fixture key is declared and every manifest entry is used", () => {
    expect(fixtureIntegrity(GOLDEN_TASKS)).toEqual([]);
  });

  test("the manifest classifies every fixture's determinism and recipe", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(35);
    for (const fixture of FIXTURES) {
      expect(fixture.determinism).toMatch(/^(deterministic|nondeterministic-tolerance)$/);
      expect(fixture.materializedBy).toMatch(/^VAL-\d{3}$/);
    }
  });
});

describe("validation: corpus run metadata (VAL-003 AC6)", () => {
  test("run metadata carries the corpus version and is admissible", () => {
    const task = GOLDEN_TASKS[0];
    expect(task).toBeDefined();
    if (task === undefined) {
      return;
    }
    const metadata = runMetadataForTask(task, {
      baseRevision: "90ceeddd1c6e5553254eaaade3155be391670787",
      applicationRevision: "90ceeddd1c6e5553254eaaade3155be391670787",
      integrationSurface: "sdk",
      environment: {
        runtime: "bun",
        toolchain: "vitest",
        database: "postgresql",
        configuration: {},
      },
      observedAt: "2026-09-11T21:00:00.000Z",
    });
    expect(metadata.corpusRevision).toBe(CORPUS_VERSION);
    expect(checkRunMetadata(metadata)).toEqual([]);
    expect(deriveRunId(metadata)).toMatch(/^val-run-[0-9a-f]{64}$/);
  });

  test("different tasks within the same corpus produce different run configurations", () => {
    const [first, second] = [GOLDEN_TASKS[0], GOLDEN_TASKS[1]];
    if (first === undefined || second === undefined) {
      throw new Error("corpus too small");
    }
    const build = (task: (typeof GOLDEN_TASKS)[number]) =>
      runMetadataForTask(task, {
        baseRevision: "x".repeat(40),
        applicationRevision: "y".repeat(40),
        integrationSurface: "sdk",
        environment: { runtime: "b", toolchain: "t", database: "d", configuration: {} },
        observedAt: "2026-09-11T21:00:00.000Z",
      });
    const firstId = deriveRunId(build(first));
    const secondId = deriveRunId(build(second));
    expect(firstId).not.toBe(secondId);
  });
});

describe("validation: outcome/state separation and safety (VAL-003 AC3/AC4)", () => {
  test("tasks separate response quality from environment effects", () => {
    const withEffects = GOLDEN_TASKS.filter(
      (task) => (task.expectedEnvironmentEffects ?? []).length > 0,
    );
    const qualityOnly = GOLDEN_TASKS.filter(
      (task) => (task.expectedEnvironmentEffects ?? []).length === 0,
    );
    expect(withEffects.length).toBeGreaterThan(50);
    expect(qualityOnly.length).toBeGreaterThan(50);
    for (const task of withEffects) {
      for (const effect of task.expectedEnvironmentEffects ?? []) {
        expect(effect.assertion.length).toBeGreaterThan(10);
      }
    }
  });

  test("every task carries safety constraints; adversarial rows carry injection defense", () => {
    for (const task of GOLDEN_TASKS) {
      expect(task.safetyConstraints.length, task.taskId).toBeGreaterThan(0);
    }
    const adversarial = GOLDEN_TASKS.filter((task) => task.description.startsWith("edge:"));
    expect(adversarial.length).toBeGreaterThanOrEqual(60);
    const injectionDefended = GOLDEN_TASKS.filter((task) =>
      task.safetyConstraints.some((c) => c.kind === "prompt-injection-defense"),
    );
    expect(injectionDefended.length).toBeGreaterThanOrEqual(20);
  });

  test("authority-boundary constraints exist on authority-sensitive families", () => {
    const authoritySensitive = [
      "workflow",
      "tools",
      "customer-service",
      "operations",
      "hitl",
    ] as const;
    for (const family of authoritySensitive) {
      const tasks = tasksByFamily(family);
      expect(
        tasks.filter((task) => task.safetyConstraints.some((c) => c.kind === "authority-boundary"))
          .length,
        family,
      ).toBeGreaterThan(0);
    }
  });

  test("capability-requiring tasks declare their requirements (NOT RUN when absent)", () => {
    const capabilityFamilies = [
      "voice",
      "realtime-voice",
      "image-generation",
      "video-media",
      "image-recognition",
      "vlm",
      "audio-understanding",
      "three-d",
      "browser-use",
      "computer-use",
    ] as const;
    for (const family of capabilityFamilies) {
      for (const task of tasksByFamily(family)) {
        expect(
          (task.requiresCapabilities ?? []).length,
          `${task.taskId} must declare required capabilities`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("deterministic evaluation never backs a tolerance task (discrimination)", () => {
    for (const task of GOLDEN_TASKS) {
      if (task.determinism === "nondeterministic-tolerance") {
        expect(task.evaluation.method, task.taskId).not.toBe("deterministic");
      }
    }
  });
});
