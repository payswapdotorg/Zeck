/**
 * Developer console module tests (DEP-010 — the console projection layer).
 *
 * Pure-function proofs over apps/dashboard/console.ts:
 *  - the workload-family catalog is the machine capability manifest's own
 *    (22 families, the recorded classifications — drift is impossible by
 *    construction, and these pins make it loud);
 *  - the sandbox playground limits: the request builder always carries
 *    the hard budget/latency constraints and the disposable-sandbox
 *    identity, can emit ONLY the frozen create vocabulary (provider
 *    selection is structurally impossible), and validation refuses
 *    over-ceiling spend BEFORE any wire call;
 *  - the developer-docs projection serves the repository's docs
 *    verbatim and refuses every traversal shape.
 */

import { describe, expect, test } from "vitest";
import {
  buildPlaygroundExecutionRequest,
  capabilityKinds,
  classificationChip,
  consoleApplicationsOf,
  consoleFamilies,
  developerDocsIndex,
  evidenceKinds,
  familiesByClassification,
  familyOf,
  inFlightCount,
  PLAYGROUND_BUDGET_LIMIT_DOLLARS,
  PLAYGROUND_BUDGET_LIMIT_MICRO_USD,
  PLAYGROUND_FORM_KEYS,
  PLAYGROUND_LATENCY_LIMIT_MS,
  PLAYGROUND_MAX_CONCURRENT_RUNS,
  PLAYGROUND_ORIGIN,
  readDeveloperDoc,
  seedCapabilities,
  validatePlaygroundForm,
} from "../../../apps/dashboard/console";
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

function executionOf(id: string, status: Execution["status"]): Execution {
  return {
    id,
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    environmentId: null,
    status,
    task: { kind: "summarize", doc: "d" },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:00:00Z",
    terminalAt: null,
  };
}

describe("the console family catalog projects the machine capability manifest", () => {
  test("every family the DEP-010 playground must cover is present", () => {
    const families = consoleFamilies().map((family) => family.family);
    expect(families.length).toBe(22);
    for (const required of [
      "text",
      "structured",
      "rag",
      "tools",
      "workflow",
      "long-running",
      "voice",
      "realtime-voice",
      "image-generation",
      "video-media",
      "image-recognition",
      "vlm",
      "audio-understanding",
      "multimodal",
      "three-d",
      "browser-use",
      "computer-use",
      "hitl",
    ]) {
      expect(families, required).toContain(required);
    }
  });

  test("every family carries a complete, honestly-classified record", () => {
    for (const family of consoleFamilies()) {
      expect(family.example.startsWith("examples/"), family.family).toBe(true);
      expect(family.availability.length, family.family).toBeGreaterThan(0);
      expect(
        family.classification === "runnable" || family.classification === "provider-gated",
        family.family,
      ).toBe(true);
      expect(typeof family.taskShape.kind, family.family).toBe("string");
      expect(family.capabilityRequirements.length, family.family).toBeGreaterThan(0);
    }
  });

  test("the availability split covers every family exactly once", () => {
    const split = familiesByClassification();
    expect(split.runnable.length + split.providerGated.length).toBe(consoleFamilies().length);
    expect(split.runnable.length).toBe(11);
    expect(split.providerGated.length).toBe(11);
  });

  test("familyOf resolves the text family and refuses unknown ids", () => {
    const text = familyOf("text");
    expect(text?.example).toBe("examples/text-summarization.ts");
    expect(text?.taskShape).toEqual({
      kind: "summarize",
      doc: "quarterly-report-01",
      maxWords: 60,
    });
    expect(familyOf("no-such-family")).toBeNull();
  });

  test("the seeded capability catalog and vocabularies project through", () => {
    const capabilities = seedCapabilities();
    expect(capabilities.length).toBeGreaterThan(0);
    expect(capabilities.some((capability) => capability.id === "text-generation")).toBe(true);
    expect(capabilityKinds().length).toBeGreaterThan(0);
    expect(evidenceKinds().length).toBeGreaterThan(0);
  });

  test("the classification chip is symbol + text (never color alone)", () => {
    expect(classificationChip("runnable")).toContain("▶ runnable");
    expect(classificationChip("provider-gated")).toContain("⊘ provider-gated");
  });
});

describe("the sandbox playground limits (client- and contract-side)", () => {
  test("the ceiling constants are the documented sandbox envelope", () => {
    expect(PLAYGROUND_BUDGET_LIMIT_MICRO_USD).toBe("2000000");
    expect(PLAYGROUND_BUDGET_LIMIT_DOLLARS).toBe("2.00");
    expect(PLAYGROUND_LATENCY_LIMIT_MS).toBe(120_000);
    expect(PLAYGROUND_MAX_CONCURRENT_RUNS).toBe(3);
  });

  test("validation accepts a valid form and parses the declared ceiling", () => {
    const result = validatePlaygroundForm({
      applicationId: "00000000-0000-7000-8000-0000000000a1",
      environmentId: "",
      spendLimitDollars: "1.50",
    });
    expect(result.values).not.toBeNull();
    expect(result.values?.spendMicroUsd).toBe("1500000");
    expect(result.errors).toEqual({});
  });

  test("validation refuses a missing application scope", () => {
    const result = validatePlaygroundForm({ applicationId: "  ", spendLimitDollars: "" });
    expect(result.values).toBeNull();
    expect(result.errors.applicationId).toContain("required");
  });

  test("validation refuses a malformed spend limit", () => {
    const result = validatePlaygroundForm({
      applicationId: "app",
      spendLimitDollars: "1.505",
    });
    expect(result.values).toBeNull();
    expect(result.errors.spendLimitDollars).toContain("dollars");
  });

  test("validation refuses an over-ceiling spend limit BEFORE any wire call", () => {
    for (const over of ["2.01", "5", "100"]) {
      const result = validatePlaygroundForm({ applicationId: "app", spendLimitDollars: over });
      expect(result.values, over).toBeNull();
      expect(result.errors.spendLimitDollars, over).toContain("capped at $2.00");
    }
  });

  test("the ceiling itself is a valid ceiling (exactly $2.00)", () => {
    const result = validatePlaygroundForm({
      applicationId: "app",
      spendLimitDollars: PLAYGROUND_BUDGET_LIMIT_DOLLARS,
    });
    expect(result.values).not.toBeNull();
    expect(result.values?.spendMicroUsd).toBe(PLAYGROUND_BUDGET_LIMIT_MICRO_USD);
  });

  test("the request builder always carries the hard constraints and sandbox identity", () => {
    const family = familyOf("text");
    expect(family).not.toBeNull();
    if (family === null) {
      return;
    }
    const request = buildPlaygroundExecutionRequest(family, {
      applicationId: "00000000-0000-7000-8000-0000000000a1",
      environmentId: "",
      spendLimitDollars: "",
    });
    expect(request.constraints?.maxCostMicroUsd).toBe(PLAYGROUND_BUDGET_LIMIT_MICRO_USD);
    expect(request.constraints?.maxLatencyMs).toBe(PLAYGROUND_LATENCY_LIMIT_MS);
    expect(request.metadata).toEqual({
      origin: PLAYGROUND_ORIGIN,
      family: "text",
      sandbox: "disposable",
    });
    expect(request.task).toBe(family.taskShape);
  });

  test("a declared ceiling below the cap is carried; above is impossible (validation refuses first)", () => {
    const family = familyOf("structured");
    expect(family).not.toBeNull();
    if (family === null) {
      return;
    }
    const below = buildPlaygroundExecutionRequest(family, {
      applicationId: "app",
      environmentId: "env-1",
      spendLimitDollars: "0.25",
    });
    expect(below.constraints?.maxCostMicroUsd).toBe("250000");
    expect(below.environmentId).toBe("env-1");
    // The builder clamps even unvalidated input to the ceiling.
    const hostile = buildPlaygroundExecutionRequest(family, {
      applicationId: "app",
      environmentId: "",
      spendLimitDollars: "999.99",
    });
    expect(hostile.constraints?.maxCostMicroUsd).toBe(PLAYGROUND_BUDGET_LIMIT_MICRO_USD);
  });

  test("the request can emit ONLY the frozen create vocabulary (no provider selection)", () => {
    const family = familyOf("vlm");
    expect(family).not.toBeNull();
    if (family === null) {
      return;
    }
    const request = buildPlaygroundExecutionRequest(family, {
      applicationId: "app",
      environmentId: "env",
      spendLimitDollars: "1",
    });
    for (const key of Object.keys(request)) {
      expect(CREATE_REQUEST_KEYS, key).toContain(key);
    }
    for (const forbidden of FORBIDDEN_REQUEST_KEYS) {
      expect(Object.keys(request), forbidden).not.toContain(forbidden);
    }
  });

  test("the form vocabulary is closed", () => {
    expect(PLAYGROUND_FORM_KEYS).toEqual([
      "applicationId",
      "environmentId",
      "spendLimitDollars",
      "idempotencyKey",
    ]);
  });

  test("in-flight counting sees only non-terminal executions", () => {
    expect(
      inFlightCount([
        executionOf("e1", "RUNNING"),
        executionOf("e2", "COMPLETED"),
        executionOf("e3", "FAILED"),
        executionOf("e4", "WAITING_USER"),
        executionOf("e5", "CANCELLED"),
        executionOf("e6", "EXPIRED"),
        executionOf("e7", "CREATED"),
      ]),
    ).toBe(3);
  });
});

describe("applications and docs projections", () => {
  test("applications aggregate by id, most recently seen first", () => {
    const facts = consoleApplicationsOf([
      {
        ...executionOf("e1", "RUNNING"),
        applicationId: "app-a",
        updatedAt: "2026-09-15T12:00:01Z",
      },
      {
        ...executionOf("e2", "COMPLETED"),
        applicationId: "app-b",
        updatedAt: "2026-09-15T13:00:00Z",
      },
      {
        ...executionOf("e3", "RUNNING"),
        applicationId: "app-a",
        updatedAt: "2026-09-15T14:00:00Z",
      },
    ]);
    expect(facts.map((fact) => fact.applicationId)).toEqual(["app-a", "app-b"]);
    expect(facts[0]?.runCount).toBe(2);
    expect(facts[0]?.lastSeenAt).toBe("2026-09-15T14:00:00Z");
  });

  test("the docs index projects the repository directory (no copied list)", () => {
    const index = developerDocsIndex();
    expect(index.length).toBeGreaterThan(10);
    expect(index.some((entry) => entry.id === "QUICKSTART.md")).toBe(true);
    expect(index.some((entry) => entry.id === "AUTH.md")).toBe(true);
    for (const entry of index) {
      expect(entry.id.endsWith(".md")).toBe(true);
      expect(entry.title.length).toBeGreaterThan(0);
    }
  });

  test("a doc is served verbatim; traversal and unknown ids are refused", () => {
    const auth = readDeveloperDoc("AUTH.md");
    expect(auth).not.toBeNull();
    expect(auth?.content).toContain("#");
    expect(readDeveloperDoc("nope.md")).toBeNull();
    expect(readDeveloperDoc("../machine/openapi.json")).toBeNull();
    expect(readDeveloperDoc("../../package.json")).toBeNull();
    expect(readDeveloperDoc("")).toBeNull();
    expect(readDeveloperDoc("AUTH.md/../../package.json")).toBeNull();
  });
});
