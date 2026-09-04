/**
 * Dashboard control-state tests (WORK-039).
 *
 * The control-plane state fixtures — the honest derivation table for the
 * control, spend, connection and improvement surfaces. Mutant-style pins
 * (AC9/IR6): a UI-only value mistaken for platform authority truth FAILS
 * here — a fabricated denial reason, a client-computed budget total, an
 * invented connection credential or a learning-derived authorization each
 * differ from the honest rendering on the same input.
 *
 * The fixtures (the Work Order's Required Verification):
 *  - policy explanation: the controlling rule renders ONLY from the
 *    platform-recorded denial event (never inferred from status);
 *  - spend/limit: usage and limits are per-run platform recordings; a
 *    missing fact stays missing (never zero, never a guess);
 *  - secret safety: no connection surface renders credential-shaped
 *    values (there is no field where one could appear);
 *  - learning authority: no recommendation ever authorizes anything —
 *    the three stages stay distinct, and nothing derives production
 *    state from an observation or a recommendation.
 */

import { describe, expect, test } from "vitest";
import { blockedExplanation } from "../../../apps/dashboard/controls";
import {
  agentSelectionFacts,
  approvalQueueFacts,
  environmentFacts,
  isSecretShapedKey,
  learningAuthorityRows,
  policyDenialOf,
  providerCategoryFacts,
  runSpendFacts,
  sumMicroUsd,
} from "../../../apps/dashboard/projection";
import type { AgentStatusView, Execution, ExecutionEvent, ExecutionResult } from "../../../sdk";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";

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
    task: { description: "Contract risk analysis" },
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
      input.provider === undefined || input.provider === null
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

function eventOf(type: string, payload: Record<string, unknown> = {}): ExecutionEvent {
  return {
    eventId: `ev-${type}-${Object.keys(payload).join("-")}`,
    executionId: EXECUTION_ID,
    type,
    sequence: 1,
    occurredAt: "2026-09-15T12:00:05Z",
    payload,
  };
}

// ---------------------------------------------------------------------------
// The policy-explanation fixture: the controlling rule is the platform's
// own recorded denial reason — nothing else produces one
// ---------------------------------------------------------------------------

describe("the policy-explanation state (AC2)", () => {
  test("a policy-denied run's controlling rule is the recorded reason, verbatim", () => {
    const events = [
      eventOf("execution.created"),
      eventOf("execution.policy-denied", {
        from: "CREATED",
        to: "CREATED",
        denied: true,
        reason: "the requested spend exceeds the effective policy ceiling",
      }),
    ];
    const denial = policyDenialOf(events);
    expect(denial?.reason).toBe("the requested spend exceeds the effective policy ceiling");
    const html = blockedExplanation(denial ?? { reason: "", occurredAt: "" });
    expect(html).toContain("Blocked by policy");
    expect(html).toContain("policy is the admission authority");
  });

  test("a CREATED run with NO denial event renders no blocked explanation (status alone never implies a denial)", () => {
    expect(policyDenialOf([eventOf("execution.created")])).toBeNull();
    // The fabricated-reason mutant: deriving a denial from the CREATED
    // status or from a fail event's message would differ here.
    expect(policyDenialOf([eventOf("execution.fail", { message: "provider error" })])).toBeNull();
  });

  test("a non-string or blank reason produces NO denial fact (never a placeholder rule)", () => {
    expect(
      policyDenialOf([eventOf("execution.policy-denied", { denied: true, reason: 42 })]),
    ).toBeNull();
    expect(
      policyDenialOf([eventOf("execution.policy-denied", { denied: true, reason: "   " })]),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The spend/limit fixture: usage and limits are per-run platform
// recordings — the dashboard computes no second accounting truth
// ---------------------------------------------------------------------------

describe("the spend/limit state (AC3)", () => {
  test("the declared limit is the recorded constraint — a run without one renders no limit, never a default", () => {
    const limited = runSpendFacts(
      executionOf({ constraints: { maxCostMicroUsd: "8000000" } }),
      resultOf({}),
    );
    expect(limited.limitMicroUsd).toBe("8000000");
    const unlimited = runSpendFacts(executionOf({}), resultOf({}));
    expect(unlimited.limitMicroUsd).toBeNull();
  });

  test("the usage total is the exact BigInt sum of the recorded costs — a missing cost contributes nothing", () => {
    const facts = [
      runSpendFacts(executionOf({}), resultOf({ cost: "6250000", provider: "neutral-p" })),
      runSpendFacts(executionOf({}), resultOf({ cost: "1250000", provider: "neutral-p" })),
      runSpendFacts(executionOf({}), resultOf({ cost: null })),
    ];
    const total = sumMicroUsd(
      facts.map((fact) => fact.costMicroUsd).filter((value): value is string => value !== null),
    );
    expect(total).toBe("7500000");
    // A float-parsing or guess-the-cost mutant differs on the same input.
    expect(sumMicroUsd(["6250000.5", "1e6"])).toBe("0");
  });

  test("the categories are the recorded providers — an unrecorded provider never appears", () => {
    const categories = providerCategoryFacts([
      runSpendFacts(executionOf({}), resultOf({ cost: "1000000", provider: "provider-a" })),
      runSpendFacts(executionOf({}), resultOf({ cost: null, provider: null })),
    ]);
    expect(categories.map((category) => category.provider)).toEqual([
      "(no provider recorded)",
      "provider-a",
    ]);
    // The null route groups as the honest no-provider row, cost $0.00
    // only because the platform recorded NO cost for it.
    expect(categories[0]?.totalMicroUsd).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// The secret-safety fixture: no connection surface renders
// credential-shaped values — no field exists where one could appear
// ---------------------------------------------------------------------------

describe("the connection secret-safety state (AC4/AC9)", () => {
  test("credential-shaped keys are recognized by the shared redaction vocabulary (the guard stays armed)", () => {
    expect(isSecretShapedKey("apiKey")).toBe(true);
    expect(isSecretShapedKey("secret")).toBe(true);
    expect(isSecretShapedKey("token")).toBe(true);
    expect(isSecretShapedKey("credential")).toBe(true);
    expect(isSecretShapedKey("provider")).toBe(false);
    expect(isSecretShapedKey("model")).toBe(false);
  });

  test("the routing facts carry only the platform's opaque neutral strings", () => {
    // A hostile provider string still renders as an opaque label — it is
    // never parsed, never executed, never treated as a credential.
    const facts = [
      runSpendFacts(
        executionOf({}),
        resultOf({ cost: "100", provider: "sk-notacrecret-provider" }),
      ),
    ];
    const categories = providerCategoryFacts(facts);
    expect(categories[0]?.provider).toBe("sk-notacrecret-provider");
    expect(categories).toHaveLength(1);
  });

  test("a hostile event payload never widens the spend facts (the typed reads only)", () => {
    // The derivation reads ONLY result.cost and execution.constraints —
    // a payload carrying secret-shaped keys cannot reach them.
    const hostile = eventOf("execution.policy-denied", {
      apiKey: "sk-live-1234567890",
      reason: "denied",
    });
    expect(policyDenialOf([hostile])?.reason).toBe("denied");
    expect(JSON.stringify(policyDenialOf([hostile]))).not.toContain("sk-live-1234567890");
  });
});

// ---------------------------------------------------------------------------
// The learning-authority fixture: no recommendation ever authorizes —
// the three stages stay distinct
// ---------------------------------------------------------------------------

describe("the learning-authority state (AC7/IR6)", () => {
  test("the recommendation row never claims authorization, application or production effect", () => {
    const rows = learningAuthorityRows();
    const recommendation = rows.find((row) => row.kind === "recommendation");
    expect(recommendation?.fact).toContain("never authorization");
    expect(recommendation?.fact).toContain("no recommendation is applied automatically");
    // The authority-flip mutant: a recommendation row claiming to change
    // what governed work runs would differ on the same input.
    expect(recommendation?.fact).not.toMatch(/applies (this )?automatically|authorizes/i);
  });

  test("the production stage is anchored to the platform's selection record — never to an observation", () => {
    const rows = learningAuthorityRows();
    const production = rows.find((row) => row.kind === "production");
    expect(production?.fact).toContain("the platform's own selection rules");
    expect(production?.fact).toContain("never implied by an observation or a recommendation");
    expect(production?.backed).toBe(true);
  });

  test("the live selection fact derives ONLY from the agent status view's latestSelection", () => {
    const status: AgentStatusView = {
      agent: {
        id: "agent-1",
        slug: "a",
        name: "Agent One",
        description: null,
        status: "active",
        activeVersionId: null,
        activeVersion: null,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-01T00:00:00Z",
      },
      activeVersion: {
        id: "ver-1",
        agentId: "agent-1",
        version: "1.0.0",
        definitionDigest: "d",
        validationState: "pending",
        validationNotes: null,
        createdAt: "2026-09-01T00:00:00Z",
      },
      latestSelection: null,
      availableVersions: [],
    };
    // No selection recorded: no production fact (never inferred from a
    // validated version or anything else).
    expect(agentSelectionFacts(status)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The environments/approvals fixture: the recorded facts only
// ---------------------------------------------------------------------------

describe("the environments and approvals state (AC5)", () => {
  test("the environments are the RECORDED ids — a null environment is the platform's own default fact", () => {
    const facts = environmentFacts([
      executionOf({ environmentId: null }),
      executionOf({ environmentId: "env-prod" }),
    ]);
    expect(facts.map((fact) => fact.environmentId)).toEqual(["env-prod", null]);
  });

  test("the approval queue is the platform's waiting states — COMPLETED work never queues", () => {
    const queue = approvalQueueFacts([
      executionOf({ status: "WAITING_HUMAN" }),
      executionOf({ status: "COMPLETED" }),
    ]);
    expect(queue).toEqual([{ executionId: EXECUTION_ID, status: "WAITING_HUMAN" }]);
  });
});
