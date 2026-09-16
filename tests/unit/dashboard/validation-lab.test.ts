/**
 * Validation Lab projection tests (DEP-025 — the validation-library
 * projection layer over repository truth).
 *
 * Pure-function proofs over apps/dashboard/validation-lab.ts:
 *  - the catalog projects the GOVERNED program state (every registered
 *    work order VAL-001..VAL-052, the honest un-issued gaps, the
 *    roadmap's own stage vocabulary — drift is impossible by
 *    construction, and these pins make it loud);
 *  - definitions are SOURCED from repository truth (spec objectives,
 *    evidence documents, app configs, the corpus, the capability matrix,
 *    the recorded validation report) — never hand-maintained copies;
 *  - the rerun envelope: the request builder always carries the hard
 *    budget/latency constraints, the disposable-sandbox identity and the
 *    LINEAGE metadata linking the NEW run to the immutable definition;
 *    the builder can emit ONLY the frozen create vocabulary;
 *  - the availability gate: missing credential NAMES are surfaced with
 *    the exact dependency, hard provider gaps are NOT RUN, and values
 *    are never read (AC6);
 *  - run history/compare derivations and the agent JSON shapes.
 */

import { describe, expect, test } from "vitest";
import {
  agentSchemaJson,
  availabilityOf,
  buildValidationRunRequest,
  defaultTaskOf,
  experimentDefinitionJson,
  experimentIsRerunnable,
  experimentOf,
  experimentsByStage,
  notRunBoundaries,
  providerCoverageRows,
  readValidationEvidence,
  recommendedExperiments,
  reproducibilityBundleJson,
  runRecordJson,
  sdkExampleOf,
  tasksOfExperiment,
  unissuedValidationIds,
  VALIDATION_BUDGET_LIMIT_DOLLARS,
  VALIDATION_BUDGET_LIMIT_MICRO_USD,
  VALIDATION_FORM_KEYS,
  VALIDATION_LAB_ORIGIN,
  VALIDATION_LATENCY_LIMIT_MS,
  VALIDATION_MAX_CONCURRENT_RUNS,
  VALIDATION_RUN_MODES,
  validateValidationRunForm,
  validationCatalogJson,
  validationComparisonOf,
  validationExperiments,
  validationRunsForWorkOrder,
  validationRunsOf,
} from "../../../apps/dashboard/validation-lab";
import { type Execution, FORBIDDEN_REQUEST_KEYS } from "../../../sdk";

const CREATE_REQUEST_KEYS: readonly string[] = [
  "applicationId",
  "environmentId",
  "task",
  "inputArtifactRefs",
  "constraints",
  "metadata",
  "userId",
];

const NO_ENV: Readonly<Record<string, string | undefined>> = {};

function executionOf(
  id: string,
  status: Execution["status"],
  metadata: Record<string, unknown>,
): Execution {
  return {
    id,
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    environmentId: null,
    status,
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: null,
    metadata,
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:01:00Z",
    terminalAt: status === "COMPLETED" ? "2026-09-15T12:01:00Z" : null,
  };
}

const LAB_METADATA = {
  origin: VALIDATION_LAB_ORIGIN,
  workOrder: "VAL-010",
  mode: "replay-exact",
  corpusTask: "text.summarize-doc.v1#000",
  corpusVersion: "val-corpus.1.0.0",
  definitionRevision: "35b0e38",
  sandbox: "disposable",
};

describe("the catalog projects the governed program state (AC1)", () => {
  test("every registered work order is a discoverable experiment", () => {
    const experiments = validationExperiments();
    expect(experiments.length).toBe(46);
    expect(experiments.map((experiment) => experiment.id)[0]).toBe("VAL-001");
    expect(experiments.map((experiment) => experiment.id).at(-1)).toBe("VAL-052");
    for (const experiment of experiments) {
      expect(experiment.status, experiment.id).toBe("complete");
      expect(experiment.title.length, experiment.id).toBeGreaterThan(0);
      expect(experiment.objective.length, experiment.id).toBeGreaterThan(0);
      expect(experiment.stage.length, experiment.id).toBeGreaterThan(0);
      expect(experiment.specPath, experiment.id).toBe(
        `spec/validation-work-orders/${experiment.id}.md`,
      );
    }
  });

  test("the un-issued ids inside VAL-001..052 are the honest gaps", () => {
    expect(unissuedValidationIds()).toEqual([
      "VAL-027",
      "VAL-028",
      "VAL-029",
      "VAL-037",
      "VAL-038",
      "VAL-039",
    ]);
  });

  test("VAL-001's evidence resolves at its registered location; the rest under docs/work-items", () => {
    expect(experimentOf("VAL-001")?.evidencePath).toBe("benchmarks/validation/evidence/VAL-001.md");
    expect(experimentOf("VAL-010")?.evidencePath).toBe("docs/work-items/VAL-010.md");
    expect(experimentOf("VAL-052")?.evidencePath).toBe("docs/work-items/VAL-052.md");
  });

  test("every evidence document is readable and non-empty (immutable, read-only)", () => {
    for (const experiment of validationExperiments()) {
      const evidence = readValidationEvidence(experiment.id);
      expect(evidence, experiment.id).not.toBeNull();
      expect(evidence?.content.length ?? 0, experiment.id).toBeGreaterThan(100);
      expect(evidence?.experiment.id, experiment.id).toBe(experiment.id);
    }
    expect(readValidationEvidence("VAL-999")).toBeNull();
    expect(readValidationEvidence("../program-state.json")).toBeNull();
  });

  test("the stage vocabulary is the roadmap's own (parsed, never re-typed)", () => {
    const stages = experimentsByStage().map((section) => section.stage);
    expect(stages).toEqual([
      "Validation laboratory foundations",
      "Customer-style application portfolio",
      "reliability / adversarial / soak validation",
      "longitudinal learning + deterministicization",
      "cost / quality / competition economics",
      "final report, pilot and release gate",
    ]);
    const total = experimentsByStage().reduce(
      (sum, section) => sum + section.experiments.length,
      0,
    );
    expect(total).toBe(46);
    expect(experimentOf("VAL-010")?.stage).toBe("Customer-style application portfolio");
    expect(experimentOf("VAL-040")?.stage).toBe("cost / quality / competition economics");
  });

  test("the definition revision is the recorded merge of record", () => {
    expect(experimentOf("VAL-010")?.definitionRevision).toBe("35b0e38");
    expect(experimentOf("VAL-001")?.mergedAs.implementationHead).toBe(
      "ac22b4494d122abbc42f5ae8df0f539347b44aae",
    );
  });

  test("the recorded coverage and NOT RUN boundaries project from the validation report", () => {
    const v10 = experimentOf("VAL-010");
    expect(v10?.recordedCoverage.length).toBe(2);
    expect(v10?.recordedCoverage[0]?.workload).toBe("Text");
    expect(v10?.recordedCoverage[0]?.status).toContain("COMPLETED");
    expect(notRunBoundaries().length).toBeGreaterThanOrEqual(10);
    expect(notRunBoundaries()[0]?.surface.length ?? 0).toBeGreaterThan(0);
    expect(providerCoverageRows().length).toBeGreaterThanOrEqual(10);
    // The 3D boundary is recorded against VAL-018's experiment.
    expect(experimentOf("VAL-018")?.notRunBoundaries.length).toBe(1);
    expect(experimentOf("VAL-018")?.notRunBoundaries[0]?.exactReason).toContain(
      "no 3D-generation-capable provider",
    );
  });
});

describe("definitions are sourced from repository truth (AC8)", () => {
  test("the app projection carries the repository's own config facts", () => {
    const v10 = experimentOf("VAL-010");
    expect(v10?.apps.map((app) => app.dir)).toEqual([
      "structured-extraction",
      "text-generation",
      "transformation",
    ]);
    const textApp = v10?.apps.find((app) => app.dir === "text-generation");
    expect(textApp?.taskCount).toBe(3);
    expect(textApp?.suitePath).toBe("tests/integration/validation/val-010-real-model.test.ts");
    // The economic app's live rows declare their env gates by NAME.
    const v40 = experimentOf("VAL-040");
    expect(v40?.apps[0]?.liveGateEnvVars.length ?? 0).toBeGreaterThan(0);
    for (const name of v40?.apps[0]?.liveGateEnvVars ?? []) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("the workload families derive mechanically from the apps' own recorded slices", () => {
    expect(experimentOf("VAL-010")?.families).toEqual(["text", "structured"]);
    expect(experimentOf("VAL-012")?.families).toEqual(["tools", "workflow"]);
    expect(experimentOf("VAL-014")?.families).toEqual(["voice", "realtime-voice"]);
    expect(experimentOf("VAL-017")?.families).toEqual([
      "image-recognition",
      "vlm",
      "audio-understanding",
    ]);
    expect(experimentOf("VAL-019")?.families).toEqual([
      "customer-service",
      "browser-use",
      "computer-use",
      "research",
      "coding",
      "operations",
      "hitl",
    ]);
    // The infra/adversarial/longitudinal/economic waves pin app-local corpora:
    // no golden-family linkage, honestly.
    expect(experimentOf("VAL-001")?.families).toEqual([]);
    expect(experimentOf("VAL-025")?.families).toEqual([]);
    expect(experimentOf("VAL-040")?.families).toEqual([]);
    expect(experimentOf("VAL-052")?.families).toEqual([]);
  });

  test("the corpus task count matches the golden corpus for the derived families", () => {
    const v10 = experimentOf("VAL-010");
    expect(v10?.corpusTaskCount).toBe(tasksOfExperiment(v10 as never).length);
    expect(v10?.corpusTaskCount).toBe(40);
    expect(experimentIsRerunnable(v10 ?? (null as never))).toBe(true);
    for (const id of ["VAL-001", "VAL-020", "VAL-030", "VAL-040", "VAL-050", "VAL-052"]) {
      expect(experimentIsRerunnable(experimentOf(id) ?? (null as never)), id).toBe(false);
    }
  });

  test("the default task is the pinned scenario's first corpus row", () => {
    expect(defaultTaskOf(experimentOf("VAL-010") ?? (null as never))?.taskId).toBe(
      "text.summarize-doc.v1#000",
    );
    expect(defaultTaskOf(experimentOf("VAL-012") ?? (null as never))?.taskId).toBe(
      "tools.single-tool.v1#000",
    );
    expect(defaultTaskOf(experimentOf("VAL-014") ?? (null as never))?.taskId).toBe(
      "voice.transcribe-utterance.v1#000",
    );
  });

  test("the copyable SDK example composes from the projected definition", () => {
    const example = sdkExampleOf(
      experimentOf("VAL-010") ?? (null as never),
      defaultTaskOf(experimentOf("VAL-010") ?? (null as never)) ?? (null as never),
    );
    expect(example).toContain('import { createZeckClient } from "./sdk"');
    expect(example).toContain('"kind":"summarize"');
    expect(example).toContain('workOrder: "VAL-010"');
    expect(example).toContain('corpusTask: "text.summarize-doc.v1#000"');
    expect(example).toContain('corpusVersion: "val-corpus.1.0.0"');
  });
});

describe("the availability gate (AC6 — exact dependency, never a PASS)", () => {
  test("credential NAMES are checked for presence; values are never read", () => {
    const v10 = experimentOf("VAL-010");
    if (v10 === null) {
      throw new Error("VAL-010 missing");
    }
    const none = availabilityOf(v10, NO_ENV);
    expect(none.presentEnvVars).toEqual([]);
    expect(none.missingEnvVars.length).toBeGreaterThan(0);
    for (const name of none.missingEnvVars) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]*_API_KEY$|^ZECK_[A-Z0-9_]+_API_KEY$/);
    }
    expect(none.hardBlocked).toEqual([]);
    const withCreds = availabilityOf(v10, {
      ...(none.missingEnvVars.length > 0 ? { [none.missingEnvVars[0] as string]: "a-value" } : {}),
    });
    expect(withCreds.presentEnvVars).toContain(none.missingEnvVars[0]);
  });

  test("a capability with no candidate provider is a hard NOT RUN boundary", () => {
    const v18 = experimentOf("VAL-018");
    if (v18 === null) {
      throw new Error("VAL-018 missing");
    }
    const view = availabilityOf(v18, {});
    expect(view.hardBlocked.length).toBe(1);
    expect(view.hardBlocked[0]?.capability).toBe("model:three-d");
    expect(view.hardBlocked[0]?.reason).toContain("never a pass");
  });

  test("the recommended starting points exclude recorded provider gaps", () => {
    const recommended = recommendedExperiments().map((experiment) => experiment.id);
    expect(recommended).toContain("VAL-010");
    expect(recommended).toContain("VAL-017");
    expect(recommended).not.toContain("VAL-018"); // three-d: no provider in the authorized set
    expect(recommended).not.toContain("VAL-040"); // suite reproduction
    expect(recommended).not.toContain("VAL-001");
  });
});

describe("the rerun envelope (AC4/AC5/AC7 — lineage, limits, frozen vocabulary)", () => {
  const v10 = experimentOf("VAL-010");
  if (v10 === null) {
    throw new Error("VAL-010 missing");
  }
  const task = defaultTaskOf(v10);
  if (task === null) {
    throw new Error("default task missing");
  }

  test("the ceiling constants are the documented sandbox envelope", () => {
    expect(VALIDATION_BUDGET_LIMIT_MICRO_USD).toBe("2000000");
    expect(VALIDATION_BUDGET_LIMIT_DOLLARS).toBe("2.00");
    expect(VALIDATION_LATENCY_LIMIT_MS).toBe(240_000);
    expect(VALIDATION_MAX_CONCURRENT_RUNS).toBe(3);
    expect(VALIDATION_RUN_MODES).toEqual(["replay-exact", "rerun-current", "modified"]);
  });

  test("the form vocabulary is closed", () => {
    expect(VALIDATION_FORM_KEYS).toEqual([
      "applicationId",
      "environmentId",
      "spendLimitDollars",
      "mode",
      "taskId",
      "idempotencyKey",
    ]);
  });

  test("validation accepts a valid rerun form", () => {
    const result = validateValidationRunForm(v10, {
      applicationId: "00000000-0000-7000-8000-0000000000a1",
      environmentId: "",
      spendLimitDollars: "1.50",
      mode: "replay-exact",
      taskId: task.taskId,
    });
    expect(result.values).not.toBeNull();
    expect(result.values?.spendMicroUsd).toBe("1500000");
    expect(result.errors).toEqual({});
  });

  test("validation refuses a task outside the experiment's families", () => {
    const result = validateValidationRunForm(v10, {
      applicationId: "app",
      mode: "replay-exact",
      taskId: "rag.kb-qa.v1#000",
    });
    expect(result.values).toBeNull();
    expect(result.errors.taskId).toContain("corpus task");
  });

  test("validation refuses an unknown mode, a missing scope and an over-ceiling spend", () => {
    expect(
      validateValidationRunForm(v10, {
        applicationId: "app",
        mode: "just-do-it",
        taskId: task.taskId,
      }).errors.mode,
    ).toContain("replay-exact");
    expect(
      validateValidationRunForm(v10, { mode: "replay-exact", taskId: task.taskId }).errors
        .applicationId,
    ).toContain("required");
    for (const over of ["2.01", "5", "100"]) {
      const result = validateValidationRunForm(v10, {
        applicationId: "app",
        mode: "replay-exact",
        taskId: task.taskId,
        spendLimitDollars: over,
      });
      expect(result.values, over).toBeNull();
      expect(result.errors.spendLimitDollars, over).toContain("capped at $2.00");
    }
  });

  test("replay-exact carries the corpus row's recorded latency target, capped by the ceiling", () => {
    const request = buildValidationRunRequest(v10, task, {
      applicationId: "app",
      environmentId: "",
      spendLimitDollars: "",
      mode: "replay-exact",
      taskId: task.taskId,
    });
    expect(request.constraints?.maxCostMicroUsd).toBe(VALIDATION_BUDGET_LIMIT_MICRO_USD);
    expect(request.constraints?.maxLatencyMs).toBe(task.latencyTargetMs);
    expect(request.task).toBe(task.input);
    expect(request.metadata).toEqual(LAB_METADATA);
  });

  test("rerun-current applies the sandbox ceiling; modified preserves lineage", () => {
    const current = buildValidationRunRequest(v10, task, {
      applicationId: "app",
      environmentId: "",
      spendLimitDollars: "",
      mode: "rerun-current",
      taskId: task.taskId,
    });
    expect(current.constraints?.maxLatencyMs).toBe(VALIDATION_LATENCY_LIMIT_MS);
    const other = tasksOfExperiment(v10).find((candidate) => candidate.taskId !== task.taskId);
    if (other === undefined) {
      throw new Error("no alternative task");
    }
    const modified = buildValidationRunRequest(v10, other, {
      applicationId: "app",
      environmentId: "env-1",
      spendLimitDollars: "0.25",
      mode: "modified",
      taskId: other.taskId,
    });
    expect(modified.constraints?.maxCostMicroUsd).toBe("250000");
    expect(modified.environmentId).toBe("env-1");
    expect(modified.metadata).toEqual({
      ...LAB_METADATA,
      mode: "modified",
      corpusTask: other.taskId,
      modifiedFrom: task.taskId,
    });
  });

  test("the builder clamps even unvalidated input and emits ONLY the frozen create vocabulary", () => {
    const hostile = buildValidationRunRequest(v10, task, {
      applicationId: "app",
      environmentId: "",
      spendLimitDollars: "999.99",
      mode: "replay-exact",
      taskId: task.taskId,
    });
    expect(hostile.constraints?.maxCostMicroUsd).toBe(VALIDATION_BUDGET_LIMIT_MICRO_USD);
    for (const key of Object.keys(hostile)) {
      expect(CREATE_REQUEST_KEYS, key).toContain(key);
    }
    for (const forbidden of FORBIDDEN_REQUEST_KEYS) {
      expect(Object.keys(hostile), forbidden).not.toContain(forbidden);
    }
  });

  test("each mode produces a DISTINCT lineage record (new immutable run identities, AC4)", () => {
    const modes = ["replay-exact", "rerun-current", "modified"] as const;
    const records = modes.map(
      (mode) =>
        buildValidationRunRequest(v10, task, {
          applicationId: "app",
          environmentId: "",
          spendLimitDollars: "",
          mode,
          taskId: task.taskId,
        }).metadata ?? {},
    );
    expect(new Set(records.map((record) => String(record.mode))).size).toBe(3);
    expect(records[0] ?? null).not.toEqual(records[1] ?? null);
    expect(records[1] ?? null).not.toEqual(records[2] ?? null);
  });
});

describe("run history and comparison (AC5)", () => {
  test("run history derives from executions carrying the lab origin", () => {
    const runs = validationRunsOf([
      executionOf("e1", "COMPLETED", LAB_METADATA),
      executionOf("e2", "RUNNING", { origin: "zeck-console-playground" }),
      executionOf("e3", "FAILED", LAB_METADATA),
      executionOf("e4", "RUNNING", {}),
    ]);
    expect(runs.map((run) => run.executionId)).toEqual(["e1", "e3"]);
    expect(validationRunsForWorkOrder(runs.map(executionOfById), "VAL-010").length).toBe(2);
  });

  test("comparison states the corpus expectation honestly (a mismatch is a finding)", () => {
    const execution = executionOf("e1", "COMPLETED", LAB_METADATA);
    const match = validationComparisonOf(execution, null);
    expect(match.expectedTerminalStatus).toBe("COMPLETED");
    expect(match.matchesExpectedTerminal).toBe(true);
    expect(match.matchesExpectedVerification).toBeNull(); // no verification recorded yet
    const miss = validationComparisonOf(executionOf("e9", "FAILED", LAB_METADATA), null);
    expect(miss.matchesExpectedTerminal).toBe(false);
    const foreign = validationComparisonOf(executionOf("e8", "RUNNING", {}), null);
    expect(foreign.expectedTerminalStatus).toBeNull();
    expect(foreign.matchesExpectedTerminal).toBeNull();
  });

  test("the run record JSON carries outcome, trajectory, latency, lineage and comparison", () => {
    const execution = executionOf("e1", "COMPLETED", LAB_METADATA);
    const record = JSON.parse(
      runRecordJson({
        execution,
        result: {
          executionId: "e1",
          status: "COMPLETED",
          route: null,
          cost: { totalMicroUsd: "86", currency: "usd" },
          usage: { inputTokens: 384, outputTokens: 20 },
          outputArtifacts: [],
          verification: [
            {
              id: "v1",
              executionId: "e1",
              criterionId: "c1",
              strategy: "s",
              status: "PASS",
              confidence: 1,
              evaluator: { kind: "k", id: "i", version: "1" },
              evidenceRefs: [],
              recordedAt: "2026-09-15T12:01:00Z",
            },
          ],
          warnings: [],
          terminalAt: "2026-09-15T12:01:00Z",
        },
        events: [
          {
            sequence: 1,
            occurredAt: "2026-09-15T12:01:00Z",
            type: "execution.completed",
          },
        ],
        verification: [{ status: "PASS" }],
        now: "2026-09-15T12:01:00Z",
      }),
    );
    expect(record.executionId).toBe("e1");
    expect(record.lineage.workOrder).toBe("VAL-010");
    expect(record.lineage.mode).toBe("replay-exact");
    expect(record.durationMs).toBe(60000);
    expect(record.outcome.verificationStatuses).toEqual(["PASS"]);
    expect(record.cost.totalMicroUsd).toBe("86");
    expect(record.trajectory[0]?.type).toBe("execution.completed");
    expect(record.comparisonToExpectation.matchesTerminalStatus).toBe(true);
    expect(record.comparisonToExpectation.matchesVerification).toBe(true);
  });
});

describe("the agent/machine interface (AC3)", () => {
  test("the catalog JSON covers every experiment with the machine shapes", () => {
    const catalog = JSON.parse(validationCatalogJson());
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.experiments.length).toBe(46);
    expect(catalog.unissuedIds).toEqual(unissuedValidationIds());
    expect(catalog.corpusVersion).toBe("val-corpus.1.0.0");
    const v10 = catalog.experiments.find((entry: { id: string }) => entry.id === "VAL-010");
    expect(v10.rerunnable).toBe(true);
    expect(v10.requiredAccess.length).toBeGreaterThan(0);
    expect(v10.links.definition).toBe("/console/validation/api/VAL-010.json");
    expect(v10.links.startRun).toBe("/console/validation/VAL-010/run");
    expect(catalog.agentInterface.schema).toBe("/console/validation/api/schema.json");
  });

  test("the definition JSON carries tasks, access, cost and the run instructions", () => {
    const definition = JSON.parse(
      experimentDefinitionJson(experimentOf("VAL-010") ?? (null as never), NO_ENV),
    );
    expect(definition.id).toBe("VAL-010");
    expect(definition.tasks.length).toBe(40);
    expect(definition.tasks[0]?.input).toEqual({
      kind: "summarize",
      doc: "quarterly-report-01",
      maxWords: 60,
    });
    expect(definition.defaultTaskId).toBe("text.summarize-doc.v1#000");
    expect(definition.availability.missingEnvVars.length).toBeGreaterThan(0);
    expect(definition.costEstimate.budgetCeilingMicroUsd).toBe("2000000");
    expect(definition.runInstructions.method).toBe("POST");
    expect(definition.runInstructions.fields.map((field: { name: string }) => field.name)).toEqual([
      ...VALIDATION_FORM_KEYS,
      "format",
    ]);
  });

  test("the schema JSON documents the full agent journey", () => {
    const schema = JSON.parse(agentSchemaJson());
    expect(schema.rerunModes).toEqual(VALIDATION_RUN_MODES);
    expect(schema.steps.list.url).toBe("/console/validation/api/catalog.json");
    expect(schema.steps.start.method).toBe("POST");
    expect(schema.steps.poll.url).toBe("/console/validation/api/runs/{executionId}.json");
    expect(schema.steps.export.url).toBe("/console/validation/api/{workOrderId}/bundle.json");
    expect(schema.providerCredentialNames.length).toBeGreaterThan(0);
  });

  test("the reproducibility bundle exports definition + evidence + reproduction", () => {
    const evidence = readValidationEvidence("VAL-010");
    if (evidence === null) {
      throw new Error("evidence missing");
    }
    const bundle = JSON.parse(reproducibilityBundleJson(evidence.experiment, evidence.content));
    expect(bundle.definition.id).toBe("VAL-010");
    expect(bundle.evidence.path).toBe("docs/work-items/VAL-010.md");
    expect(bundle.evidence.content).toBe(evidence.content);
    expect(bundle.reproduction.suites).toContain(
      "tests/integration/validation/val-010-real-model.test.ts",
    );
    expect(bundle.reproduction.governedBattery).toContain("bun run test:unit");
    expect(bundle.defaultCorpusTask.taskId).toBe("text.summarize-doc.v1#000");
  });
});

// A tiny helper for the history test: rebuild executions from facts.
function executionOfById(run: { executionId: string; status: string }): Execution {
  return executionOf(run.executionId, run.status as Execution["status"], LAB_METADATA);
}
