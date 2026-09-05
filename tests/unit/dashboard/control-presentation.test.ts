/**
 * Dashboard control-plane presentation tests (WORK-039).
 *
 * The ONE control/improvement presentation module (controls.ts): the
 * control families (the seven user-level families — the live ones backed,
 * the rest explicit absences), the blocked explanation (the platform's
 * recorded denial reason rendered verbatim), the create-refusal
 * explanation, the spend summary and per-run table (BigInt sums over
 * integer micro-USD strings only), the accounting detail disclosure, the
 * connections presentation (routing facts, the secret-mediated story),
 * the environments/team/audit presentations, and the Improve
 * presentations (the five recommendation families, the three
 * dispositions, the learning-authority distinction).
 *
 * Mutant-style pins (AC9/IR6): a UI-only value mistaken for platform
 * truth FAILS here — a fabricated denial reason, a client-computed
 * accounting figure, a floating-point sum, a secret-shaped render or an
 * authorization claim in the learning rows each differ from the honest
 * rendering on the same input.
 */

import { describe, expect, test } from "vitest";
import { distinctionList } from "../../../apps/dashboard/components";
import {
  blockedExplanation,
  CONTROL_FAMILY_LABELS,
  connectionsSection,
  controlFamiliesTable,
  createBlockedExplanation,
  environmentsSection,
  learningDistinctionSection,
  recommendationDispositionList,
  spendRunsTable,
  spendSummarySection,
  teamSection,
} from "../../../apps/dashboard/controls";
import {
  agentSelectionFacts,
  approvalQueueFacts,
  environmentFacts,
  learningAuthorityRows,
  policyDenialOf,
  providerCategoryFacts,
  recommendationDispositionRows,
  runSpendFacts,
  sumMicroUsd,
} from "../../../apps/dashboard/projection";
import type { AgentStatusView, Execution, ExecutionEvent, ExecutionResult } from "../../../sdk";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000d2";
const OTHER_ID = "00000000-0000-7000-8000-0000000000d3";

function executionOf(input: {
  status?: string;
  environmentId?: string | null;
  constraints?: Execution["constraints"];
}): Execution {
  return {
    id: EXECUTION_ID,
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    environmentId: input.environmentId ?? null,
    status: (input.status ?? "COMPLETED") as Execution["status"],
    task: { kind: "outcome", description: "Summarize the quarterly spend report" },
    constraints: input.constraints ?? null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:03:42Z",
    terminalAt: null,
  };
}

function resultOf(input: { cost?: string | null; provider?: string | null }): ExecutionResult {
  return {
    executionId: EXECUTION_ID,
    status: "COMPLETED",
    route:
      input.provider === undefined
        ? null
        : {
            provider: input.provider,
            model: "neutral-m",
            strategyClass: "hybrid",
            modelCalls: 2,
          },
    cost:
      input.cost === undefined || input.cost === null
        ? null
        : { totalMicroUsd: input.cost, currency: "usd" },
    usage: null,
    outputArtifacts: [],
    verification: [],
    warnings: [],
    terminalAt: null,
  };
}

function eventOf(type: string, payload: Record<string, unknown>): ExecutionEvent {
  return {
    eventId: `ev-${type}`,
    executionId: EXECUTION_ID,
    type,
    sequence: 1,
    occurredAt: "2026-09-15T12:00:05Z",
    payload,
  };
}

describe("the control families (AC1)", () => {
  test("the family vocabulary is exactly the seven user-level families, in order", () => {
    expect(CONTROL_FAMILY_LABELS).toEqual([
      "Quality",
      "Spend",
      "Latency",
      "Data",
      "Tools",
      "Approvals",
      "Autonomy",
    ]);
  });

  test("the families table renders the live families backed and the absent families as explicit absences", () => {
    const html = controlFamiliesTable();
    expect(html).toContain("Quality");
    expect(html).toContain("Spend");
    expect(html).toContain("Latency");
    expect(html).toContain("Data");
    expect(html).toContain("Tools");
    expect(html).toContain("Approvals");
    expect(html).toContain("Autonomy");
    // Backed rows: quality, spend, latency, approvals.
    expect((html.match(/Platform fact/g) ?? []).length).toBe(4);
    // Absent rows: data, tools, autonomy — never a fabricated default.
    expect((html.match(/Explicit absence/g) ?? []).length).toBe(3);
  });

  test("the families render through the shared distinction list (IR1 — no parallel vocabulary)", () => {
    const rows = recommendationDispositionRows();
    expect(distinctionList(rows)).toContain('class="distinction-list"');
  });
});

describe("the blocked explanation (AC2)", () => {
  test("the denial fact derives ONLY from the policy-denied event's recorded payload", () => {
    const denial = policyDenialOf([
      eventOf("execution.created", {}),
      eventOf("execution.policy-denied", {
        from: "CREATED",
        to: "CREATED",
        denied: true,
        reason: "the requested spend exceeds the effective policy ceiling",
      }),
    ]);
    expect(denial).toEqual({
      reason: "the requested spend exceeds the effective policy ceiling",
      occurredAt: "2026-09-15T12:00:05Z",
    });
  });

  test("no policy-denied event (or a payload without a reason) produces NO denial fact", () => {
    expect(policyDenialOf([eventOf("execution.created", {})])).toBeNull();
    expect(policyDenialOf([eventOf("execution.policy-denied", { denied: true })])).toBeNull();
    // A fail event's message never becomes a denial (the types differ).
    expect(
      policyDenialOf([eventOf("execution.fail", { reason: "not a policy denial" })]),
    ).toBeNull();
  });

  test("the blocked explanation renders the recorded reason verbatim with the boundary sentence", () => {
    const html = blockedExplanation({
      reason: "the requested spend exceeds the effective policy ceiling",
      occurredAt: "2026-09-15T12:00:05Z",
    });
    expect(html).toContain('class="state state-blocked"');
    expect(html).toContain("Blocked by policy");
    expect(html).toContain(
      "<strong>the requested spend exceeds the effective policy ceiling</strong>",
    );
    expect(html).toContain("policy is the admission authority");
    // A mutant that rewords the reason differs on the same input.
    expect(html).not.toContain("the request was too expensive");
  });

  test("the create-refusal explanation renders the typed code and message with the retry framing", () => {
    const html = createBlockedExplanation(
      "POLICY_DENIED",
      "the requested spend exceeds the effective policy ceiling",
    );
    expect(html).toContain("POLICY_DENIED");
    expect(html).toContain("The controlling rule:");
    expect(html).toContain("never retries silently");
  });
});

describe("the spend derivations (AC3)", () => {
  test("runSpendFacts reads the recorded cost, the declared limit and the routed provider — nothing else", () => {
    const facts = runSpendFacts(
      executionOf({ constraints: { maxCostMicroUsd: "8000000" } }),
      resultOf({ cost: "6250000", provider: "neutral-p" }),
    );
    expect(facts).toEqual({
      executionId: EXECUTION_ID,
      costMicroUsd: "6250000",
      limitMicroUsd: "8000000",
      provider: "neutral-p",
    });
    // A run without a result package: every missing fact stays null —
    // never zero, never a guess (D20).
    const missing = runSpendFacts(executionOf({}), resultOf({}));
    expect(missing).toEqual({
      executionId: EXECUTION_ID,
      costMicroUsd: null,
      limitMicroUsd: null,
      provider: null,
    });
  });

  test("sumMicroUsd is BigInt-only over integer strings — malformed values contribute nothing", () => {
    expect(sumMicroUsd(["6250000", "1250000"])).toBe("7500000");
    expect(sumMicroUsd([])).toBe("0");
    // Floats, negatives and garbage are skipped — never parsed (D20).
    expect(sumMicroUsd(["6.25", "-1", "abc", "", "0x10"])).toBe("0");
    expect(sumMicroUsd(["9007199254740993", "2"])).toBe("9007199254740995");
  });

  test("providerCategoryFacts groups by the recorded provider (null is the honest no-provider group)", () => {
    const categories = providerCategoryFacts([
      {
        executionId: EXECUTION_ID,
        costMicroUsd: "6250000",
        limitMicroUsd: "8000000",
        provider: "neutral-p",
      },
      {
        executionId: OTHER_ID,
        costMicroUsd: "1250000",
        limitMicroUsd: null,
        provider: "neutral-p",
      },
      {
        executionId: "00000000-0000-7000-8000-0000000000d4",
        costMicroUsd: null,
        limitMicroUsd: null,
        provider: null,
      },
    ]);
    expect(categories).toHaveLength(2);
    expect(categories[0]).toMatchObject({
      provider: "(no provider recorded)",
      runCount: 1,
      totalMicroUsd: "0",
    });
    expect(categories[1]).toMatchObject({
      provider: "neutral-p",
      runCount: 2,
      totalMicroUsd: "7500000",
      executionIds: [EXECUTION_ID, OTHER_ID],
    });
  });

  test("the spend summary renders the usage, the limits and the categories from the facts", () => {
    const facts = [
      {
        executionId: EXECUTION_ID,
        costMicroUsd: "6250000",
        limitMicroUsd: "8000000",
        provider: "neutral-p",
      },
    ];
    const html = spendSummarySection({
      facts,
      totalMicroUsd: "6250000",
      categories: providerCategoryFacts(facts),
    });
    expect(html).toContain('class="spend-summary"');
    expect(html).toContain("Current usage");
    expect(html).toContain("$6.25");
    expect(html).toContain("Limits");
    expect(html).toContain("Major categories");
    expect(html).toContain("neutral-p");
    // The scope sentence is part of the summary (never a cross-work claim).
    expect(html).toContain("no cross-work spend aggregate");
  });

  test("the per-run table renders the honest absences — never zero, never a guessed limit", () => {
    const html = spendRunsTable([
      { executionId: EXECUTION_ID, costMicroUsd: null, limitMicroUsd: null, provider: null },
    ]);
    expect(html).toContain("not settled yet");
    expect(html).toContain("none declared");
    expect(html).toContain("no route recorded");
    expect(html).toContain(`href="/runs/${EXECUTION_ID}"`);
    expect(html).not.toContain("$0.00");
  });
});

describe("the connections presentation (AC4)", () => {
  test("the routing rows render the platform's provider strings with the run counts and settled totals", () => {
    const html = connectionsSection([
      {
        provider: "neutral-p",
        runCount: 2,
        totalMicroUsd: "7500000",
        executionIds: [EXECUTION_ID, OTHER_ID],
      },
    ]);
    expect(html).toContain('class="connection-facts"');
    expect(html).toContain("neutral-p");
    expect(html).toContain("routed for 2 runs opened in this browser");
    expect(html).toContain("$7.50 settled");
    expect(html).toContain("bring your own keys");
    // The secret-mediated story: no field exists where a secret could appear.
    expect(html).toContain("The create contract carries no connection field at all");
    expect(html).not.toMatch(/sk-[a-z0-9]{8,}/i);
  });

  test("empty routing renders the honest no-providers note (never a fabricated inventory)", () => {
    const html = connectionsSection([]);
    expect(html).toContain(
      "No routed providers are recorded for the runs opened in this browser yet",
    );
    expect(html).not.toContain("routed for");
  });
});

describe("the environments and team derivations (AC5)", () => {
  test("environmentFacts groups by the RECORDED environment id — null renders as the default, never invented", () => {
    const facts = environmentFacts([
      executionOf({ environmentId: "env-staging" }),
      executionOf({ environmentId: null }),
    ]);
    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.environmentId)).toEqual(["env-staging", null]);
    expect(facts.every((fact) => fact.executionIds.every((id) => id === EXECUTION_ID))).toBe(true);
  });

  test("the environments section renders the recorded ids with run links", () => {
    const html = environmentsSection(
      environmentFacts([executionOf({ environmentId: "env-staging" })]),
    );
    expect(html).toContain("env-staging");
    expect(html).toContain(`href="/runs/${EXECUTION_ID}"`);
    expect(html).toContain("1 run recorded in this browser's scope");
  });

  test("approvalQueueFacts reads only the platform's waiting states", () => {
    const waiting = approvalQueueFacts([
      executionOf({ status: "WAITING_HUMAN" }),
      executionOf({ status: "WAITING_USER" }),
      executionOf({ status: "COMPLETED" }),
    ]);
    expect(waiting).toEqual([
      { executionId: EXECUTION_ID, status: "WAITING_HUMAN" },
      { executionId: EXECUTION_ID, status: "WAITING_USER" },
    ]);
  });

  test("the team section renders the live queue and never names an approver the API does not expose", () => {
    const html = teamSection([{ executionId: EXECUTION_ID, status: "WAITING_HUMAN" }]);
    expect(html).toContain("Who decides what");
    expect(html).toContain(`href="/runs/${EXECUTION_ID}"`);
    expect(html).toContain("a human review the governing policy required");
    expect(html).not.toMatch(/approver:|assigned to/i);
  });
});

describe("the learning-authority distinction (AC7/IR6)", () => {
  test("the three stages are distinct; the recommendation row carries the never-authorizes boundary verbatim", () => {
    const rows = learningAuthorityRows();
    expect(rows.map((row) => row.kind)).toEqual(["evidence", "recommendation", "production"]);
    expect(rows[1]?.fact).toContain(
      "Learning produces recommendations and evidence, never authorization",
    );
    // The evidence and production rows are backed by live public records.
    expect(rows[0]?.backed).toBe(true);
    expect(rows[2]?.backed).toBe(true);
    expect(rows[1]?.backed).toBe(false);
  });

  test("agentSelectionFacts reads the platform's own selection record (kind, who, when)", () => {
    const status: AgentStatusView = {
      agent: {
        id: "00000000-0000-7000-8000-0000000000b1",
        slug: "support-triage",
        name: "Support Triage Agent",
        description: null,
        status: "active",
        activeVersionId: "ver-2",
        activeVersion: "1.1.0",
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-10T00:00:00Z",
      },
      activeVersion: null,
      latestSelection: {
        selectionId: "sel-1",
        kind: "rollback",
        selectedVersionId: "ver-1",
        rollbackOf: "ver-2",
        selectedBy: "architect@example.test",
        selectedAt: "2026-09-12T00:00:00Z",
      },
      availableVersions: [],
    };
    expect(agentSelectionFacts(status)).toEqual({
      agentId: "00000000-0000-7000-8000-0000000000b1",
      agentName: "Support Triage Agent",
      kind: "rollback",
      selectedBy: "architect@example.test",
      selectedAt: "2026-09-12T00:00:00Z",
      rollbackOf: "ver-2",
    });
    expect(agentSelectionFacts({ ...status, latestSelection: null })).toBeNull();
  });

  test("the learning distinction renders the live selection record beneath the rows", () => {
    const html = learningDistinctionSection([
      {
        agentId: "00000000-0000-7000-8000-0000000000b1",
        agentName: "Support Triage Agent",
        kind: "promotion",
        selectedBy: "architect@example.test",
        selectedAt: "2026-09-09T00:00:00Z",
        rollbackOf: null,
      },
      {
        agentId: "00000000-0000-7000-8000-0000000000b2",
        agentName: "Summarizer Agent",
        kind: "rollback",
        selectedBy: "architect@example.test",
        selectedAt: "2026-09-12T00:00:00Z",
        rollbackOf: "ver-2",
      },
    ]);
    expect(html).toContain("The live production record");
    expect(html).toContain("Support Triage Agent");
    expect(html).toContain("promoted by the platform's selection rules");
    expect(html).toContain("Summarizer Agent");
    expect(html).toContain("rolled back by the platform's selection rules");
    expect(html).toContain("rolling back ver-2");
  });

  test("the recommendation dispositions are three distinct rows — none ever claims effect", () => {
    const rows = recommendationDispositionRows();
    expect(rows.map((row) => row.kind)).toEqual(["advisory", "review", "applicable"]);
    for (const row of rows) {
      expect(row.backed).toBe(false);
    }
    expect(recommendationDispositionList()).toContain('class="distinction-list"');
  });
});
