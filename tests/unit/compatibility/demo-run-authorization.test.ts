/**
 * PPR-018A — the Demo Mirror run authorization + activation tests
 * (scope items 7/8; the battery's "demo-run authorization" and "public
 * Demo Mirror route/run regression").
 *
 * THE FIRST IMPOSSIBILITY, pinned at every layer:
 * a demo run without AI_EXECUTION_COMPLETE cannot happen — the
 * demo-run service authorizes on the DERIVED status only, and the
 * route-level handler composes the same authorization.
 *
 * The certified path uses a SYNTHETIC live-proof-shaped record (the
 * PPR-017 precedent: a unit proof of the RUN MACHINERY, never a
 * certification of any real application) bound through the REAL file
 * source (a temp compatibility tree: deploy/evidence record +
 * compat/<app>/demo entry) and a TEST driver — proving the exact
 * plug-in path every PPR-020..027 work order takes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CompatibilityEvidenceRecord,
  createDemoRunService,
  createRuntimeRegistry,
  type DemoRunExecutor,
  EXAMPLE_CODING_ASSISTANT_RECORD,
  EXAMPLE_RAG_KNOWLEDGE_APP_RECORD,
  evaluateCompatibility,
  type PinnedRuntimeDriver,
  type PinnedRuntimeSession,
  type TraceRead,
  type ZeckTraceSource,
} from "../../../src/integrations/compatibility/public";

const APP_ID = "00000000-0000-7000-8000-0000000000d9";
const PIN = { upstreamRevision: "1".repeat(40), integrationRevision: "2".repeat(40) };
const NOW = "2026-09-27T00:00:00Z";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000f1";

/** The synthetic CERTIFIED record (all five admission rules satisfied). */
function certifiedRecord(): CompatibilityEvidenceRecord {
  return {
    recordId: "synthetic-certified-record",
    recordBasis: "live-proof",
    pinnedApplication: {
      identity: {
        name: "Synthetic certified test application",
        repository: "https://example.invalid/synthetic-certified",
        applicationId: APP_ID,
      },
      pin: PIN,
    },
    graph: {
      edges: [
        {
          edgeId: "main-completion",
          component: "chat loop",
          surface: "text-generation",
          transport: "provider client",
          externalExecution: "provider model",
          materiality: "the main model call",
        },
      ],
    },
    dispositions: [
      {
        edgeId: "main-completion",
        disposition: "delegated",
        zeckExecutionIds: [EXECUTION_ID],
        evidenceBasis: "live",
      },
    ],
    egressObservation: { mode: "deny", status: "observed-clean", violations: [] },
    providerCredentials: [],
    runtimeEvidence: {
      corpusDeclared: true,
      corpusUsability: "verified",
      observations: ["the representative corpus replayed functionally"],
    },
    comparison: [],
    zeckTraces: [
      {
        edgeId: "main-completion",
        executionId: EXECUTION_ID,
        applicationId: APP_ID,
        found: true,
        status: "COMPLETED",
        terminal: true,
        eventCount: 6,
        verificationCount: 1,
        passingVerificationCount: 1,
        correlated: true,
      },
    ],
    limitations: [],
    notRunCauses: [],
    recordedAt: NOW,
  };
}

/** A test session: exact pins, no credentials, one resolved edge execution. */
function certifiedSession(
  environmentFacts: PinnedRuntimeSession["environmentFacts"] = [],
): PinnedRuntimeSession {
  return {
    descriptor: {
      runtimeId: "compat/synthetic-certified",
      applicationId: APP_ID,
      pin: PIN,
      startedAt: NOW,
    },
    environmentFacts,
    async executeTask(task) {
      return {
        taskId: task.taskId,
        succeeded: true,
        detail: `${task.title} resolved through the pinned runtime`,
        durationMs: 1800,
        edgeExecutions: [
          {
            edgeId: "main-completion",
            executionId: EXECUTION_ID,
            outcome: "resolved",
            latencyMs: 1500,
            usage: { inputTokens: 90, outputTokens: 40 },
            costMicroUsd: "2500000",
          },
        ],
        failureCount: 0,
        retryCount: 0,
        egressObservation: { mode: "deny", status: "observed-clean", violations: [] },
        unavailable: null,
      };
    },
    async stop() {},
  };
}

const DRIVER: PinnedRuntimeDriver = {
  runtimeId: "compat/synthetic-certified",
  identity: {
    name: "Synthetic certified test application",
    repository: "https://example.invalid/synthetic-certified",
    applicationId: APP_ID,
  },
  pin: PIN,
  start: async () => certifiedSession(),
};

/** The in-memory trace source: every execution reads back correlated+completed. */
const TRACE_SOURCE: ZeckTraceSource = {
  async readExecutionTrace(_applicationId, _executionId): Promise<TraceRead> {
    return {
      execution: { id: EXECUTION_ID, applicationId: APP_ID, status: "COMPLETED", terminal: true },
      events: [
        { eventId: "e1", sequence: 1, type: "execution.created" },
        { eventId: "e2", sequence: 2, type: "execution.completed" },
      ],
      verification: [{ id: "v1", status: "PASS" }],
      route: { provider: "neutral-provider", model: "neutral-model", strategyClass: "hybrid" },
      costMicroUsd: "2500000",
      usage: { inputTokens: 90, outputTokens: 40 },
    };
  },
};

const CERTIFIED_ENTRY = {
  demoId: "synthetic-certified",
  evidenceRecordId: "synthetic-certified-record",
  representativeTask: {
    title: "Run the synthetic certified task",
    description: "The representative task the certified run replays.",
  },
  runBinding: { kind: "pinned-runtime", runtime: "compat/synthetic-certified" } as const,
  reproducibility: {
    instructions: "The synthetic machinery test: run the certified path through the harness.",
    pinnedUpstreamRevision: "1".repeat(40),
    integrationRevision: "2".repeat(40),
  },
  warnings: [],
};

/** The matching discovered inventory (the certification reconciliation input). */
function matchingInventory(): import("../../../src/integrations/compatibility/public").DiscoveredEdgeInventory {
  return {
    source: "synthetic test discovery",
    edges: [
      {
        edgeId: "main-completion",
        component: "chat loop",
        surface: "text-generation",
        transport: "provider client",
        externalExecution: "provider model",
        materiality: "the main model call",
      },
    ],
  };
}

function serviceOf(drivers: readonly PinnedRuntimeDriver[] = [DRIVER]) {
  const registry = createRuntimeRegistry({ drivers });
  return createDemoRunService({
    registry,
    traceSource: TRACE_SOURCE,
    credentialEnvVarNames: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    now: () => NOW,
  });
}

// ---------------------------------------------------------------------------
// Part 1: the authorization machine (the service level)
// ---------------------------------------------------------------------------

describe("the demo-run authorization machine (IMPOSSIBILITY: no run without AI_EXECUTION_COMPLETE)", () => {
  test("the synthetic certified record derives AI_EXECUTION_COMPLETE (the machinery's positive case)", () => {
    expect(evaluateCompatibility(certifiedRecord(), matchingInventory()).status).toBe(
      "AI_EXECUTION_COMPLETE",
    );
    // WITHOUT its discovered inventory the record stays unreconciled
    // (INVENTORY_MISSING forbids COMPLETE — the coverage gate).
    expect(evaluateCompatibility(certifiedRecord()).status).not.toBe("AI_EXECUTION_COMPLETE");
  });

  test("an UNASSESSED record is refused (the fixture record can never certify)", async () => {
    const service = serviceOf();
    const entry = {
      ...CERTIFIED_ENTRY,
      evidenceRecordId: EXAMPLE_CODING_ASSISTANT_RECORD.recordId,
    };
    const result = await service.run(entry, EXAMPLE_CODING_ASSISTANT_RECORD);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("never runs an uncertified integration path");
    expect(result.reason).toContain("UNASSESSED");
  });

  test("a PARTIAL record is refused (fixture-basis delegations certify nothing)", async () => {
    const service = serviceOf();
    const entry = {
      ...CERTIFIED_ENTRY,
      evidenceRecordId: EXAMPLE_RAG_KNOWLEDGE_APP_RECORD.recordId,
    };
    const result = await service.run(entry, EXAMPLE_RAG_KNOWLEDGE_APP_RECORD);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("PARTIAL");
  });

  test("a certified record with a 'none' run binding is refused (no runtime to execute)", async () => {
    const service = serviceOf();
    const result = await service.run(
      { ...CERTIFIED_ENTRY, runBinding: { kind: "none" } },
      certifiedRecord(),
      matchingInventory(),
    );
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("no pinned application runtime to execute");
  });

  test("a certified record with NO registered driver is refused (an honest miss, never a fallback)", async () => {
    const service = serviceOf([]); // empty registry
    const result = await service.run(CERTIFIED_ENTRY, certifiedRecord(), matchingInventory());
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("No pinned runtime is registered");
    expect(result.reason).toContain("synthetic response is never substituted");
  });

  test("IMPOSSIBILITY (unpinned execution): a registered driver with the WRONG pins is refused", async () => {
    const wrongPinDriver: PinnedRuntimeDriver = {
      ...DRIVER,
      pin: { ...PIN, upstreamRevision: "9".repeat(40) },
    };
    const service = serviceOf([wrongPinDriver]);
    const result = await service.run(CERTIFIED_ENTRY, certifiedRecord(), matchingInventory());
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("unpinned application execution is refused");
  });

  test("IMPOSSIBILITY (credential-bearing runtime): a session reporting a provider credential is refused", async () => {
    const credentialDriver: PinnedRuntimeDriver = {
      ...DRIVER,
      start: async () =>
        certifiedSession([
          { envVarName: "OPENAI_API_KEY", present: true },
          { envVarName: "ANTHROPIC_API_KEY", present: false },
        ]),
    };
    const service = serviceOf([credentialDriver]);
    const result = await service.run(CERTIFIED_ENTRY, certifiedRecord(), matchingInventory());
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("provider credentials");
    expect(result.reason).toContain("OPENAI_API_KEY");
    // The VALUE never appears (names only) — there is no value to leak.
    expect(result.reason).not.toMatch(/sk-/);
  });

  test("IMPOSSIBILITY (unpinned session): a session whose descriptor mismatches is refused", async () => {
    const mismatchedDriver: PinnedRuntimeDriver = {
      ...DRIVER,
      start: async () => ({
        ...certifiedSession(),
        descriptor: {
          runtimeId: "compat/synthetic-certified",
          applicationId: APP_ID,
          pin: { ...PIN, integrationRevision: "8".repeat(40) },
          startedAt: NOW,
        },
      }),
    };
    const service = serviceOf([mismatchedDriver]);
    const result = await service.run(CERTIFIED_ENTRY, certifiedRecord(), matchingInventory());
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("does not match the bound record's exact pins");
  });
});

describe("the certified demo run (the machinery's execution path — never a synthetic response)", () => {
  test("the authorized run executes the pinned runtime and records the honest facts", async () => {
    const service = serviceOf();
    const result = await service.run(CERTIFIED_ENTRY, certifiedRecord(), matchingInventory());
    expect(result.ran).toBe(true);
    expect(result.outcome).toBeDefined();
    const outcome = result.outcome as NonNullable<typeof result.outcome>;
    expect(outcome.taskRun.succeeded).toBe(true);
    expect(outcome.taskRun.edgeExecutions[0]?.executionId).toBe(EXECUTION_ID);
    expect(outcome.traces[0]?.correlated).toBe(true);
    expect(outcome.traces[0]?.passingVerificationCount).toBe(1);
    expect(outcome.credentialErasure.erased).toBe(true);
    expect(outcome.runtime).toEqual({
      runtimeId: "compat/synthetic-certified",
      pin: PIN,
    });
    expect(outcome.egressObservation).toEqual({
      mode: "deny",
      status: "observed-clean",
      violations: [],
    });
  });

  test("a FAILED task still renders honestly (ran=true, succeeded=false — never hidden)", async () => {
    const failingDriver: PinnedRuntimeDriver = {
      ...DRIVER,
      start: async () => ({
        ...certifiedSession(),
        executeTask: async (task) => ({
          taskId: task.taskId,
          succeeded: false,
          detail: "the certified path ran but the task's own check failed",
          durationMs: 900,
          edgeExecutions: [],
          failureCount: 1,
          retryCount: 0,
          egressObservation: null,
          unavailable: null,
        }),
      }),
    };
    const service = serviceOf([failingDriver]);
    const result = await service.run(CERTIFIED_ENTRY, certifiedRecord(), matchingInventory());
    expect(result.ran).toBe(true);
    expect(result.outcome?.taskRun.succeeded).toBe(false);
    expect(result.outcome?.taskRun.detail).toContain("check failed");
  });
});

// ---------------------------------------------------------------------------
// Part 2: the route-level activation (the REAL file source composition)
// ---------------------------------------------------------------------------

let previousCwd = "";
let compatTree = "";

beforeAll(() => {
  // A temp compatibility tree the file source discovers: the evidence
  // record file (deploy/evidence) + the demo entry file
  // (compat/<app>/demo). This is EXACTLY the plug-in shape a real
  // application work order ships.
  previousCwd = process.cwd();
  compatTree = mkdtempSync(join(tmpdir(), "ppr-018a-demo-"));
  mkdirSync(join(compatTree, "deploy", "evidence"), { recursive: true });
  mkdirSync(join(compatTree, "compat", "synthetic-certified", "demo"), { recursive: true });
  writeFileSync(
    join(compatTree, "deploy", "evidence", "synthetic-certified-record.json"),
    `${JSON.stringify(
      { ...certifiedRecord(), discoveredInventory: matchingInventory() },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(compatTree, "compat", "synthetic-certified", "demo", "demo-entry.json"),
    `${JSON.stringify(CERTIFIED_ENTRY, null, 2)}\n`,
  );
  process.chdir(compatTree);
});

afterAll(() => {
  process.chdir(previousCwd);
  rmSync(compatTree, { recursive: true, force: true });
});

describe("the public Demo Mirror route/run regression (the real file-source composition)", () => {
  test("the file source discovers the record + the entry, and the projection derives COMPLETE", async () => {
    const { demoMirrorEntries, demoMirrorIndexRows, demoMirrorSourceDefects } = await import(
      "../../../apps/dashboard/demo-mirror"
    );
    expect(demoMirrorSourceDefects()).toEqual([]);
    const entry = demoMirrorEntries().find(
      (candidate) => candidate.demoId === "synthetic-certified",
    );
    expect(entry).toBeDefined();
    expect(entry?.runBinding).toEqual({
      kind: "pinned-runtime",
      runtime: "compat/synthetic-certified",
    });
    const row = demoMirrorIndexRows().find(
      (candidate) => candidate.demoId === "synthetic-certified",
    );
    expect(row?.status).toBe("AI_EXECUTION_COMPLETE");
    expect(row?.runAvailable).toBe(true);
    expect(row?.evidenceFile).toContain("synthetic-certified-record.json");
    // The fixture demos still render with their honest statuses.
    const statuses = new Map(
      demoMirrorIndexRows().map((candidate) => [candidate.demoId, candidate.status]),
    );
    expect(statuses.get("example-coding-assistant")).toBe("UNASSESSED");
    expect(statuses.get("example-rag-knowledge-app")).toBe("PARTIAL");
  });

  test("IMPOSSIBILITY (route level): a run request for an uncertified demo is refused even with an executor bound", async () => {
    const { demoMirrorRunHandler } = await import("../../../apps/dashboard/demo-mirror");
    const redirects: { location: string }[] = [];
    const executor: DemoRunExecutor = {
      run: async () => {
        throw new Error("the executor must never be called for an uncertified demo");
      },
    };
    const result = await demoMirrorRunHandler(
      "example-coding-assistant",
      (location) => {
        redirects.push({ location });
        return { status: 303, location };
      },
      executor,
    );
    expect(result.status).toBe(303);
    const location = redirects[0]?.location ?? "";
    expect(location.startsWith("/console/demos/example-coding-assistant?run=")).toBe(true);
    expect(decodeURIComponent(location.split("run=")[1] ?? "")).toContain(
      "never runs an uncertified",
    );
  });

  test("the certified route runs the pinned integration through the executor and records the outcome", async () => {
    const demoMirror = await import("../../../apps/dashboard/demo-mirror");
    const redirects: { location: string }[] = [];
    const service = serviceOf();
    const result = await demoMirror.demoMirrorRunHandler(
      "synthetic-certified",
      (location) => {
        redirects.push({ location });
        return { status: 303, location };
      },
      {
        run: async (entry, record, inventory) => service.run(entry, record, inventory ?? null),
      },
    );
    expect(result.status).toBe(303);
    expect(redirects[0]?.location).toContain("run=ok");
    // The run outcome renders on the detail page (the same projection).
    const detail = demoMirror.demoMirrorDetailBody("synthetic-certified");
    expect(detail.body).toContain("Certified run result");
    expect(detail.body).toContain("resolved through the pinned runtime");
    expect(detail.body).toContain(EXECUTION_ID);
    // The machine twin carries the run + the binding + the source file.
    const facts = JSON.parse(demoMirror.demoMirrorDetailFactsJson("synthetic-certified")) as {
      runBinding: { kind: string; runtime: string };
      evidenceSourceFile: string | null;
      lastRun: { ran: boolean; outcome: { taskRun: { succeeded: boolean } } | null } | null;
    };
    expect(facts.runBinding).toEqual({
      kind: "pinned-runtime",
      runtime: "compat/synthetic-certified",
    });
    expect(facts.evidenceSourceFile).toContain("synthetic-certified-record.json");
    expect(facts.lastRun?.ran).toBe(true);
    expect(facts.lastRun?.outcome?.taskRun.succeeded).toBe(true);
    // The evidence links section renders the record + binding.
    expect(detail.body).toContain("Evidence &amp; bindings");
    expect(detail.body).toContain("pinned runtime");
  });

  test("the certified route WITHOUT an executor renders the honest no-executor refusal", async () => {
    const { demoMirrorRunHandler } = await import("../../../apps/dashboard/demo-mirror");
    const redirects: { location: string }[] = [];
    const result = await demoMirrorRunHandler(
      "synthetic-certified",
      (location) => {
        redirects.push({ location });
        return { status: 303, location };
      },
      undefined,
    );
    expect(result.status).toBe(303);
    const location = redirects[0]?.location ?? "";
    const reason = decodeURIComponent(location.split("run=")[1] ?? "");
    expect(reason).toContain("no demo-run executor is bound");
    expect(reason).toContain("synthetic response is never substituted");
  });

  test("an unknown demo id redirects to the index error (no guessed projection)", async () => {
    const { demoMirrorRunHandler } = await import("../../../apps/dashboard/demo-mirror");
    const redirects: { location: string }[] = [];
    const result = await demoMirrorRunHandler(
      "no-such-demo",
      (location) => {
        redirects.push({ location });
        return { status: 303, location };
      },
      undefined,
    );
    expect(result.status).toBe(303);
    expect(redirects[0]?.location).toBe("/console/demos?error=unknown-demo");
  });
});
