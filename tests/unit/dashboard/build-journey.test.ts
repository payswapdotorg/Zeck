/**
 * The WORK-037 Build-experience unit suite — the pure derivations behind
 * the Build hub, the agent proposal/detail surfaces, the workload
 * creation (through the ONE governed execution create contract), the
 * long-running workload facts and the training/evaluation/release
 * distinction.
 *
 * The same honesty discipline as the WORK-036 work-journey suite: every
 * derivation is pinned to the public wire shapes; a typed platform fact
 * or an explicit absence — never an invention. Mutants that merge the
 * deployment/execution distinction, the training/evaluation/release
 * states, or that fabricate workload facts fail these pins.
 */

import { describe, expect, test } from "vitest";
import {
  glanceGrid,
  longRunningWorkloadSection,
  trainingStateList,
} from "../../../apps/dashboard/components";
import {
  agentGlanceFacts,
  buildWorkloadRequest,
  completionExplainerRows,
  DEPLOYMENT_EXECUTION_DISTINCTION,
  declaredBudgetMicroUsd,
  deploymentGlanceFacts,
  deriveWorkloadFacts,
  forbiddenRequestKeys,
  type GlanceFact,
  trainingStateRows,
  validateWorkloadForm,
  type WorkloadFacts,
} from "../../../apps/dashboard/projection";
import type { AgentStatusView, Execution, ExecutionEvent, ExecutionResult } from "../../../sdk";

const NOW = "2026-09-15T12:00:00Z";

function executionOf(status: Execution["status"], constraints: unknown = null): Execution {
  return {
    id: "00000000-0000-7000-8000-0000000000d9",
    applicationId: "app-1",
    environmentId: null,
    status,
    task: { kind: "outcome", description: "Train a classifier" },
    constraints: constraints as Execution["constraints"],
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: status === "COMPLETED" ? "2026-09-15T12:40:00Z" : null,
  };
}

function eventOf(
  type: string,
  sequence: number,
  payload: Record<string, unknown> = {},
): ExecutionEvent {
  return {
    eventId: `ev-${sequence}`,
    executionId: "00000000-0000-7000-8000-0000000000d9",
    type,
    sequence,
    occurredAt: "2026-09-15T12:30:00Z",
    payload,
  };
}

const EMPTY_RESULT: ExecutionResult = {
  executionId: "00000000-0000-7000-8000-0000000000d9",
  status: "RUNNING",
  route: null,
  cost: null,
  usage: null,
  outputArtifacts: [],
  verification: [],
  warnings: [],
  terminalAt: null,
};

// ---------------------------------------------------------------------------
// The workload form → the ONE governed create contract (AC6)
// ---------------------------------------------------------------------------

describe("validateWorkloadForm", () => {
  test("a complete workload form validates (application + purpose)", () => {
    const { values, errors } = validateWorkloadForm({
      applicationId: "app-1",
      purpose: "Train a classifier on the support tickets",
      budgetDollars: "50.25",
      datasets: "dataset-1\ndataset-2",
      userId: "user-9",
    });
    expect(values).not.toBeNull();
    expect(errors).toEqual({});
  });

  test("the application id and the purpose are required (per-field errors)", () => {
    const { values, errors } = validateWorkloadForm({ purpose: "", applicationId: " " });
    expect(values).toBeNull();
    expect(errors.applicationId).toContain("application id is required");
    expect(errors.purpose).toContain("Describe what the workload");
  });

  test("an invalid budget is rejected with the dollars vocabulary (never silently coerced)", () => {
    const { values, errors } = validateWorkloadForm({
      applicationId: "app-1",
      purpose: "x",
      budgetDollars: "fifty",
    });
    expect(values).toBeNull();
    expect(errors.budgetDollars).toContain("dollar amount");
  });

  test("hostile dataset tokens are rejected (never silently dropped)", () => {
    const { values, errors } = validateWorkloadForm({
      applicationId: "app-1",
      purpose: "x",
      datasets: "dataset-1, drop table users;--",
    });
    expect(values).toBeNull();
    expect(errors.datasets).toContain("one id per line");
  });
});

describe("buildWorkloadRequest", () => {
  test("maps the budget to the integer micro-USD cost constraint and the datasets to inputArtifactRefs", () => {
    const request = buildWorkloadRequest({
      applicationId: "app-1",
      purpose: "Train a classifier on the support tickets",
      budgetDollars: "50.25",
      datasets: "dataset-1\ndataset-2",
      userId: "user-9",
    });
    expect(request.applicationId).toBe("app-1");
    expect(request.task).toEqual({
      kind: "outcome",
      description: "Train a classifier on the support tickets",
    });
    expect(request.inputArtifactRefs).toEqual(["dataset-1", "dataset-2"]);
    expect(request.constraints).toEqual({ maxCostMicroUsd: "50250000" });
    expect(request.userId).toBe("user-9");
  });

  test("absent optionals are omitted (never empty-string fields on the wire)", () => {
    const request = buildWorkloadRequest({
      applicationId: "app-1",
      purpose: "Batch the exports",
      budgetDollars: "",
      datasets: "",
      userId: "",
    });
    expect("inputArtifactRefs" in request).toBe(false);
    expect("constraints" in request).toBe(false);
    expect("userId" in request).toBe(false);
  });

  test("the closed create vocabulary holds: no forbidden key can ever be emitted", () => {
    const request = buildWorkloadRequest({
      applicationId: "app-1",
      purpose: "Batch the exports",
      budgetDollars: "1",
      datasets: "",
      userId: "",
    });
    for (const key of forbiddenRequestKeys()) {
      expect(key in request).toBe(false);
      expect(key in (request.task as Record<string, unknown>)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The long-running workload facts (AC8) — typed event facts only
// ---------------------------------------------------------------------------

describe("deriveWorkloadFacts", () => {
  test("checkpoint events yield the recency facts (typed payload fields: sequence + position)", () => {
    const facts = deriveWorkloadFacts([
      eventOf("execution.created", 1),
      eventOf("execution.start", 2),
      eventOf("checkpoint-recorded", 3, {
        checkpointSequence: 1,
        lastEventPosition: 4200,
        planId: "plan-1",
        planRevision: 3,
        resourceClass: "accelerated",
      }),
      eventOf("checkpoint-recorded", 4, {
        checkpointSequence: 2,
        lastEventPosition: 9800,
      }),
    ]);
    expect(facts.present).toBe(true);
    expect(facts.checkpointCount).toBe(2);
    expect(facts.lastCheckpoint?.sequence).toBe(2);
    expect(facts.lastCheckpoint?.lastEventPosition).toBe(9800);
    expect(facts.lastCheckpoint?.source).toBe("checkpoint-recorded");
  });

  test("the MOST RECENT checkpoint wins regardless of input order (chronological discipline)", () => {
    const facts = deriveWorkloadFacts([
      eventOf("checkpoint-recorded", 4, { checkpointSequence: 2, lastEventPosition: 9800 }),
      eventOf("checkpoint-recorded", 3, { checkpointSequence: 1, lastEventPosition: 4200 }),
    ]);
    expect(facts.lastCheckpoint?.sequence).toBe(2);
  });

  test("recovery events map to their kinds (resume/interruption/wake-up); the most recent wins", () => {
    const facts = deriveWorkloadFacts([
      eventOf("checkpoint-recorded", 3, { checkpointSequence: 1 }),
      eventOf("interruption-requested", 4),
      eventOf("resume-recorded", 5),
    ]);
    expect(facts.recovery?.kind).toBe("recovered");
    expect(facts.recovery?.source).toBe("resume-recorded");
  });

  test("a resume denial is surfaced as its own kind — never silently treated as recovered", () => {
    const facts = deriveWorkloadFacts([eventOf("resume-denied", 3)]);
    expect(facts.present).toBe(true);
    expect(facts.recovery?.kind).toBe("resume-denied");
  });

  test("lease/heartbeat-shaped events are NOT workload facts (the mechanics stay internal)", () => {
    const facts = deriveWorkloadFacts([
      eventOf("lease-renewed", 1, { worker: "w-1", epoch: 3 }),
      eventOf("heartbeat", 2, { worker: "w-1" }),
    ]);
    expect(facts.present).toBe(false);
    expect(facts.checkpointCount).toBe(0);
    expect(facts.recovery).toBeNull();
  });

  test("an empty or ordinary stream carries no workload facts", () => {
    expect(deriveWorkloadFacts([]).present).toBe(false);
    expect(
      deriveWorkloadFacts([eventOf("execution.created", 1), eventOf("execution.start", 2)]).present,
    ).toBe(false);
  });
});

describe("declaredBudgetMicroUsd", () => {
  test("reads the recorded cost constraint from the execution record (a public wire fact)", () => {
    expect(declaredBudgetMicroUsd(executionOf("RUNNING", { maxCostMicroUsd: "50250000" }))).toBe(
      "50250000",
    );
  });

  test("no constraints or a non-string value ⇒ the honest null", () => {
    expect(declaredBudgetMicroUsd(executionOf("RUNNING", null))).toBeNull();
    expect(declaredBudgetMicroUsd(executionOf("RUNNING", { maxCostMicroUsd: 42 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The training/evaluation/release distinction (AC7)
// ---------------------------------------------------------------------------

describe("trainingStateRows", () => {
  test("exactly four DISTINCT states in the canonical order", () => {
    const rows = trainingStateRows(executionOf("RUNNING"), []);
    expect(rows.map((row) => row.kind)).toEqual([
      "compute-complete",
      "training-complete",
      "evaluation-passed",
      "release-approved",
    ]);
  });

  test("the release row is ALWAYS the explicit absence — even for a completed run with every check passing", () => {
    const rows = trainingStateRows(executionOf("COMPLETED"), [
      {
        id: "v-1",
        executionId: "e",
        criterionId: "c",
        strategy: "digest-check",
        status: "PASS",
        confidence: 0.9,
        evaluator: { kind: "check", id: "e", version: "1" },
        evidenceRefs: [],
        recordedAt: NOW,
      },
    ]);
    const release = rows[3];
    expect(release?.backed).toBe(false);
    expect(release?.fact).toContain("never");
    // The conflation mutant would derive release approval from completion.
    expect(release?.fact).not.toMatch(/^Yes/);
  });

  test("the training-complete row is the honest non-distinction, NOT a copy of the compute row", () => {
    const rows = trainingStateRows(executionOf("COMPLETED"), []);
    expect(rows[0]?.fact).not.toBe(rows[1]?.fact);
    expect(rows[1]?.fact).toContain("does not separately distinguish");
  });

  test("the evaluation row reads ONLY the verification facts (pass counts)", () => {
    const rows = trainingStateRows(executionOf("COMPLETED"), [
      {
        id: "v-1",
        executionId: "e",
        criterionId: "c",
        strategy: "digest-check",
        status: "PASS",
        confidence: 0.9,
        evaluator: { kind: "check", id: "e", version: "1" },
        evidenceRefs: [],
        recordedAt: NOW,
      },
      {
        id: "v-2",
        executionId: "e",
        criterionId: "c2",
        strategy: "digest-check",
        status: "FAIL",
        confidence: null,
        evaluator: { kind: "check", id: "e", version: "1" },
        evidenceRefs: [],
        recordedAt: NOW,
      },
    ]);
    const evaluation = rows[2];
    expect(evaluation?.backed).toBe(true);
    expect(evaluation?.fact).toContain("1 of 2");
  });

  test("no verification results ⇒ the honest no-facts note (never a fabricated pass)", () => {
    const evaluation = trainingStateRows(executionOf("COMPLETED"), [])[2];
    expect(evaluation?.backed).toBe(false);
    expect(evaluation?.fact).toContain("No verification results");
  });
});

describe("completionExplainerRows (the proposal-side AC7 preview)", () => {
  test("the same four distinct states, stated ahead of commitment", () => {
    const rows = completionExplainerRows();
    expect(rows.map((row) => row.kind)).toEqual([
      "compute-complete",
      "training-complete",
      "evaluation-passed",
      "release-approved",
    ]);
    expect(rows[3]?.fact).toContain("Never claimed");
  });
});

// ---------------------------------------------------------------------------
// The at-a-glance grids (AC3/AC4)
// ---------------------------------------------------------------------------

const AGENT_VIEW: AgentStatusView = {
  agent: {
    id: "agent-1",
    slug: "support-triage",
    name: "Support Triage Agent",
    description: "Handles incoming tickets and escalates billing disputes.",
    status: "active",
    activeVersionId: "ver-2",
    activeVersion: "1.1.0",
    createdAt: NOW,
    updatedAt: NOW,
  },
  activeVersion: {
    id: "ver-2",
    agentId: "agent-1",
    version: "1.1.0",
    definitionDigest: "d2c4",
    validationState: "validated",
    validationNotes: null,
    createdAt: NOW,
  },
  latestSelection: null,
  availableVersions: [],
};

describe("agentGlanceFacts", () => {
  test("the nine AC3 dimensions in order, each a fact or an explicit absence", () => {
    const cells = agentGlanceFacts(AGENT_VIEW);
    expect(cells.map((cell: GlanceFact) => cell.label)).toEqual([
      "Purpose",
      "Capabilities",
      "Tools and integrations",
      "Autonomy",
      "Approvals",
      "Quality",
      "Cost",
      "Version",
      "Current deployment",
    ]);
    // The facts the projection DOES carry.
    expect(cells[0]?.backed).toBe(true);
    expect(cells[0]?.fact).toContain("escalates billing disputes");
    expect(cells[5]?.backed).toBe(true);
    expect(cells[5]?.fact).toContain("validated");
    expect(cells[7]?.backed).toBe(true);
    expect(cells[7]?.fact).toContain("1.1.0");
    // The explicit absences (never fabricated).
    for (const index of [1, 2, 3, 4, 6, 8]) {
      expect(cells[index]?.backed).toBe(false);
    }
    expect(cells[6]?.fact).toContain("no per-agent cost facts");
    expect(cells[8]?.fact).toContain("never represented as an execution status");
  });

  test("no active version ⇒ the honest no-selection facts for quality and version", () => {
    const cells = agentGlanceFacts({ ...AGENT_VIEW, activeVersion: null });
    expect(cells[5]?.backed).toBe(false);
    expect(cells[5]?.fact).toContain("No active version");
    expect(cells[7]?.backed).toBe(false);
  });

  test("a missing description is the honest absence (never a fabricated purpose)", () => {
    const cells = agentGlanceFacts({
      ...AGENT_VIEW,
      agent: { ...AGENT_VIEW.agent, description: null },
    });
    expect(cells[0]?.backed).toBe(false);
    expect(cells[0]?.fact).toContain("No description is recorded");
  });
});

describe("deploymentGlanceFacts", () => {
  test("the six AC4 dimensions, ALL explicit absences (no public deployment authority)", () => {
    const cells = deploymentGlanceFacts();
    expect(cells.map((cell: GlanceFact) => cell.label)).toEqual([
      "Availability",
      "Version",
      "Health",
      "Channels and endpoints",
      "Activity",
      "Operational controls",
    ]);
    for (const cell of cells) {
      expect(cell.backed).toBe(false);
      expect(cell.fact).toContain("Not exposed by the public API");
    }
    // The key invariant is stated on the availability cell.
    expect(cells[0]?.fact).toContain("never represented as an execution status");
    // AC5: the operational-controls cell names the governed consequence
    // path and the no-action-buttons fact.
    expect(cells[5]?.fact).toContain("consequence preview before commitment");
    expect(cells[5]?.fact).toContain("no action buttons");
  });
});

// ---------------------------------------------------------------------------
// The rendered surfaces (component pins)
// ---------------------------------------------------------------------------

describe("glanceGrid and trainingStateList", () => {
  test("every cell carries the fact/absence marker (text, never color alone)", () => {
    const html = glanceGrid(agentGlanceFacts(AGENT_VIEW));
    expect(html).toContain("glance-grid");
    expect((html.match(/class="glance-cell"/g) ?? []).length).toBe(9);
    expect(html).toContain(">Platform fact</p>");
    expect(html).toContain(">Not exposed by the public API</p>");
  });

  test("hostile fact text is escaped at the boundary", () => {
    const hostile = agentGlanceFacts({
      ...AGENT_VIEW,
      agent: { ...AGENT_VIEW.agent, description: "<script>alert(1)</script>" },
    });
    const html = glanceGrid(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("the distinction list renders the four states as separate rows", () => {
    const html = trainingStateList(trainingStateRows(executionOf("COMPLETED"), []));
    expect((html.match(/<li>/g) ?? []).length).toBe(4);
    expect(html).toContain("Compute complete");
    expect(html).toContain("Training complete");
    expect(html).toContain("Evaluation passed");
    expect(html).toContain("Release approved");
  });
});

describe("longRunningWorkloadSection", () => {
  const facts: WorkloadFacts = {
    checkpointCount: 2,
    lastCheckpoint: {
      sequence: 2,
      occurredAt: "2026-09-15T12:30:00Z",
      lastEventPosition: 9800,
      source: "checkpoint-recorded",
    },
    recovery: { kind: "recovered", occurredAt: "2026-09-15T12:31:00Z", source: "resume-recorded" },
    present: true,
  };

  test("renders progress, checkpoint recency, spend, recovery AND the four-state distinction (AC7+AC8)", () => {
    const html = longRunningWorkloadSection({
      execution: executionOf("RUNNING", { maxCostMicroUsd: "50250000" }),
      result: { ...EMPTY_RESULT, cost: { totalMicroUsd: "1234000", currency: "usd" } },
      workload: facts,
    });
    expect(html).toContain("Long-running workload");
    expect(html).toContain("open the activity timeline");
    expect(html).toContain("Checkpoint 2 of 2");
    expect(html).toContain("position 9800");
    expect(html).toContain("Settled cost: $1.23");
    expect(html).toContain("budget constraint");
    expect(html).toContain("Recovered");
    expect(html).toContain("resume-recorded");
    expect(html).toContain("Compute complete");
    expect(html).toContain("Release approved");
  });

  test("the lease/heartbeat mechanics note is explicit (AC8's never-expose rule)", () => {
    const html = longRunningWorkloadSection({
      execution: executionOf("RUNNING"),
      result: EMPTY_RESULT,
      workload: facts,
    });
    expect(html).toContain("never shown");
    expect(html).not.toMatch(/lease epoch|worker epoch|heartbeat interval/i);
  });

  test("no settled cost yet ⇒ the honest not-settled note with the declared budget fact", () => {
    const html = longRunningWorkloadSection({
      execution: executionOf("RUNNING", { maxCostMicroUsd: "50250000" }),
      result: EMPTY_RESULT,
      workload: facts,
    });
    expect(html).toContain("No settled cost is recorded yet");
    expect(html).toContain("$50.25");
  });

  test("a resume denial renders the denial consequence (the governed stop is Cancel)", () => {
    const html = longRunningWorkloadSection({
      execution: executionOf("RUNNING"),
      result: EMPTY_RESULT,
      workload: {
        ...facts,
        recovery: { kind: "resume-denied", occurredAt: NOW, source: "resume-denied" },
      },
    });
    expect(html).toContain("resume was denied");
    expect(html).toContain("governed stop remains Cancel");
  });
});

// ---------------------------------------------------------------------------
// The deployment/execution distinction statement (the key invariant)
// ---------------------------------------------------------------------------

describe("DEPLOYMENT_EXECUTION_DISTINCTION", () => {
  test("states both directions of the invariant", () => {
    expect(DEPLOYMENT_EXECUTION_DISTINCTION).toContain("persistent availability");
    expect(DEPLOYMENT_EXECUTION_DISTINCTION).toContain("one governed unit of work");
    expect(DEPLOYMENT_EXECUTION_DISTINCTION).toContain("never an execution status");
    expect(DEPLOYMENT_EXECUTION_DISTINCTION).toContain("never describes a deployment");
  });
});
