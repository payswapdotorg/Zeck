/**
 * WORK-036 unit proofs — the Home/Work-creation/execution journey contract.
 *
 * The honest failure classification (AC10: execution failure vs quality
 * failure, never merged, never invented; recoverability surfaced ONLY
 * from platform-typed facts — never a heuristic over the reason text),
 * the wait question (AC8), the composer's attachment parsing (AC2:
 * inputArtifactRefs — the one live secondary affordance), the
 * quality-failure notice on the result surface, the wait decision
 * surface's consequence/return-to-work framing, and the WhyPanel's §11
 * answers (AC7).
 */

import { describe, expect, test } from "vitest";
import { resultSurface, whyPanel } from "../../../apps/dashboard/components";
import {
  buildExecutionRequest,
  classifyFailure,
  deriveRecoverability,
  parseAttachmentRefs,
  validateExecutionForm,
  waitQuestion,
} from "../../../apps/dashboard/projection";
import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../../sdk";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";

function execution(status: string): Execution {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(status);
  return {
    id: EXECUTION_ID,
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    environmentId: null,
    status: status as Execution["status"],
    task: { kind: "outcome", description: "Contract risk analysis" },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:03:42Z",
    terminalAt: terminal ? "2026-09-15T12:03:42Z" : null,
  };
}

function check(status: string, index: number): VerificationResult {
  return {
    id: `v-${index}`,
    executionId: EXECUTION_ID,
    criterionId: `criterion-${index}`,
    strategy: "digest-check",
    status: status as VerificationResult["status"],
    confidence: status === "PASS" ? 0.9 : null,
    evaluator: { kind: "check", id: "eval-1", version: "3" },
    evidenceRefs: [`ref-${index}`],
    recordedAt: "2026-09-15T12:03:41Z",
  };
}

function result(status: string, verification: readonly VerificationResult[]): ExecutionResult {
  const terminal = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(status);
  return {
    executionId: EXECUTION_ID,
    status: status as ExecutionResult["status"],
    route: { provider: "neutral-p", model: "neutral-m", strategyClass: "hybrid", modelCalls: 3 },
    cost: { totalMicroUsd: "4180000", currency: "usd" },
    usage: null,
    outputArtifacts: [],
    verification,
    warnings: [],
    terminalAt: terminal ? "2026-09-15T12:03:42Z" : null,
  };
}

function events(...types: string[]): ExecutionEvent[] {
  return types.map((type, index) => ({
    eventId: `ev-${index}`,
    executionId: EXECUTION_ID,
    type,
    sequence: index + 1,
    occurredAt: `2026-09-15T12:00:${String(index).padStart(2, "0")}Z`,
    payload: {},
  }));
}

function failEvent(message: string): ExecutionEvent {
  return {
    eventId: "ev-fail",
    executionId: EXECUTION_ID,
    type: "execution.fail",
    sequence: 9,
    occurredAt: "2026-09-15T12:02:00Z",
    payload: { message },
  };
}

function typedFactEvent(payload: Record<string, unknown>): ExecutionEvent {
  return {
    eventId: "ev-fact",
    executionId: EXECUTION_ID,
    type: "execution.tool-result",
    sequence: 9,
    occurredAt: "2026-09-15T12:02:00Z",
    payload,
  };
}

function waitEvent(question: string): ExecutionEvent {
  return {
    eventId: "ev-wait",
    executionId: EXECUTION_ID,
    type: "execution.wait-user",
    sequence: 8,
    occurredAt: "2026-09-15T12:01:00Z",
    payload: { question },
  };
}

// ---------------------------------------------------------------------------
// AC10: the honest failure classification
// ---------------------------------------------------------------------------

describe("classifyFailure (the two failure dimensions, never merged, never invented)", () => {
  test("a FAILED status is an execution failure carrying the recorded reason", () => {
    const classification = classifyFailure(execution("FAILED"), result("FAILED", []), [
      ...events("execution.created", "execution.start"),
      failEvent("the connection rejected the request"),
    ]);
    expect(classification.dimension).toBe("execution");
    expect(classification.recordedReason).toBe("the connection rejected the request");
  });

  test("a FAILED status without a failure event records NO reason (never a guess)", () => {
    const classification = classifyFailure(
      execution("FAILED"),
      result("FAILED", []),
      events("execution.created", "execution.start"),
    );
    expect(classification.dimension).toBe("execution");
    expect(classification.recordedReason).toBeNull();
  });

  test("a COMPLETED execution with FAIL checks is a QUALITY failure (a distinct dimension)", () => {
    const classification = classifyFailure(
      execution("COMPLETED"),
      result("COMPLETED", [check("PASS", 1), check("FAIL", 2)]),
      events("execution.created", "execution.start", "execution.pass"),
    );
    expect(classification.dimension).toBe("quality");
    expect(classification.failedChecks).toBe(1);
    expect(classification.recordedReason).toBeNull();
  });

  test("a COMPLETED execution with all-PASS checks classifies as none (no failure narrative)", () => {
    const classification = classifyFailure(
      execution("COMPLETED"),
      result("COMPLETED", [check("PASS", 1)]),
      events("execution.created", "execution.pass"),
    );
    expect(classification.dimension).toBe("none");
  });

  test("the execution-failure surface states the dimension distinction and the honest recoverability limitation", () => {
    const html = resultSurface({
      execution: execution("FAILED"),
      result: result("FAILED", []),
      events: [...events("execution.created"), failEvent("the tool rejected the request")],
    });
    expect(html).toContain("Zeck could not complete this execution");
    expect(html).toContain("execution failure");
    expect(html).toContain("different fact from a quality failure");
    expect(html).toContain("the tool rejected the request");
    expect(html).toContain("Start a new attempt");
  });

  test("AC10 amendment: with no typed recoverability fact, the limitation is explicit — and NO reason-describing prose survives", () => {
    const html = resultSurface({
      execution: execution("FAILED"),
      result: result("FAILED", []),
      events: [...events("execution.created"), failEvent("the connection was rejected")],
    });
    expect(html).toContain(
      "no authoritative recoverability or provider/infrastructure classification",
    );
    expect(html).toContain("does not classify the recorded reason");
    // The rejected heuristic: prose asking the user to read the reason's
    // description as a recoverability classification.
    expect(html).not.toContain("When the recorded reason describes");
    expect(html).not.toContain("recovery-note");
    // The quality-failure authoritative-fact distinction.
    expect(html).toContain("failed verification checks are the platform's authoritative facts");
  });

  test("AC10 amendment: a platform-recorded retryable=true fact is surfaced verbatim and constrains the actions", () => {
    const html = resultSurface({
      execution: execution("FAILED"),
      result: result("FAILED", []),
      events: [
        ...events("execution.created"),
        typedFactEvent({ outcomeClass: "tool-failure", failureClass: "timeout", retryable: true }),
      ],
    });
    expect(html).toContain("Recoverability (platform-recorded)");
    expect(html).toContain("recorded this failure as <strong>retryable</strong>");
    expect(html).toContain("on the execution.tool-result event");
    expect(html).toContain("A new attempt is the governed path");
    expect(html).toContain('class="button-link"');
  });

  test("AC10 amendment: a platform-recorded retryable=false fact states the not-retryable consequence honestly", () => {
    const html = resultSurface({
      execution: execution("FAILED"),
      result: result("FAILED", []),
      events: [
        ...events("execution.created"),
        typedFactEvent({ outcomeClass: "provider-failure", retryable: false }),
      ],
    });
    expect(html).toContain("recorded this failure as <strong>not retryable</strong>");
    expect(html).toContain("expected to fail the same way");
    expect(html).toContain("Refine the request before starting a new attempt");
    expect(html).not.toContain("A new attempt is the governed path");
  });

  test("AC10 amendment: a failure class without a retryable bit surfaces the class verbatim and the missing-bit limitation", () => {
    const html = resultSurface({
      execution: execution("FAILED"),
      result: result("FAILED", []),
      events: [
        ...events("execution.created"),
        typedFactEvent({ outcomeClass: "tool-failure", failureClass: "output-contract" }),
      ],
    });
    expect(html).toContain("recorded failure class <strong>output-contract</strong>");
    expect(html).toContain("no retryable classification for this failure");
    expect(html).toContain("does not infer one from the recorded class");
  });

  test("the quality-failure notice renders for completed-but-failed checks (the other dimension)", () => {
    const html = resultSurface({
      execution: execution("COMPLETED"),
      result: result("COMPLETED", [check("PASS", 1), check("FAIL", 2), check("FAIL", 3)]),
      events: events("execution.created", "execution.pass"),
    });
    expect(html).toContain("The work completed, but 2 verification checks failed");
    expect(html).toContain("quality failure");
    expect(html).toContain("different fact from an execution failure");
    expect(html).toContain("Review the evidence");
    expect(html).toContain("The failed checks are the platform's authoritative facts here");
    expect(html).toContain("no provider or infrastructure failure to recover from");
    // The execution-failure wording never appears on this surface.
    expect(html).not.toContain("Zeck could not complete this execution");
  });

  test("an all-PASS completed execution renders neither failure surface", () => {
    const html = resultSurface({
      execution: execution("COMPLETED"),
      result: result("COMPLETED", [check("PASS", 1)]),
      events: events("execution.created", "execution.pass"),
    });
    expect(html).not.toContain("failure");
  });
});

// ---------------------------------------------------------------------------
// AC10 amendment: deriveRecoverability — platform-typed facts ONLY
// ---------------------------------------------------------------------------

describe("deriveRecoverability (typed facts only — never free-text interpretation)", () => {
  test("a platform-recorded retryable bit is read as the literal boolean (both values)", () => {
    expect(
      deriveRecoverability([typedFactEvent({ outcomeClass: "provider-failure", retryable: true })]),
    ).toEqual({
      retryable: true,
      failureClass: "provider-failure",
      source: "execution.tool-result",
    });
    expect(
      deriveRecoverability([
        typedFactEvent({ outcomeClass: "provider-failure", retryable: false }),
      ]),
    ).toEqual({
      retryable: false,
      failureClass: "provider-failure",
      source: "execution.tool-result",
    });
  });

  test("the failureClass / outcomeClass platform vocabulary is surfaced verbatim (no recoverability inference)", () => {
    const fact = deriveRecoverability([typedFactEvent({ failureClass: "timeout" })]);
    expect(fact).toEqual({
      retryable: null,
      failureClass: "timeout",
      source: "execution.tool-result",
    });
    const outcomeOnly = deriveRecoverability([typedFactEvent({ outcomeClass: "workload-failed" })]);
    expect(outcomeOnly).toEqual({
      retryable: null,
      failureClass: "workload-failed",
      source: "execution.tool-result",
    });
  });

  test("no typed fact anywhere yields the honest nulls (never a guess)", () => {
    expect(deriveRecoverability(events("execution.created", "execution.start"))).toEqual({
      retryable: null,
      failureClass: null,
      source: null,
    });
  });

  test("free-text reason fields are NEVER consulted — a message that says 'timeout' stays unclassified", () => {
    // The forbidden heuristic, pinned as absent: the reason text mentioning
    // a retry-sounding word does not become a retryable fact.
    const fact = deriveRecoverability([failEvent("the request timed out and is transient")]);
    expect(fact).toEqual({ retryable: null, failureClass: null, source: null });
  });

  test("the most recent recorded fact wins per fact (the last-event precedent)", () => {
    const earlier = {
      ...typedFactEvent({ retryable: true, failureClass: "timeout" }),
      sequence: 5,
    };
    const later = {
      ...typedFactEvent({ retryable: false }),
      sequence: 7,
      type: "execution.sandbox-completed",
    };
    expect(deriveRecoverability([earlier, later])).toEqual({
      retryable: false,
      failureClass: "timeout",
      source: "execution.sandbox-completed",
    });
  });

  test("an out-of-order stream is read chronologically (sequence, not array order)", () => {
    const late = typedFactEvent({ retryable: true });
    const early: ExecutionEvent = {
      eventId: "ev-early",
      executionId: EXECUTION_ID,
      type: "execution.created",
      sequence: 1,
      occurredAt: "2026-09-15T12:00:00Z",
      payload: {},
    };
    expect(deriveRecoverability([late, early]).retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC8: the wait question and the decision surface
// ---------------------------------------------------------------------------

describe("waitQuestion (the recorded platform question, never fabricated)", () => {
  test("extracts the question payload from the last wait event", () => {
    expect(
      waitQuestion([
        ...events("execution.created", "execution.start"),
        waitEvent("Approve the external side effect?"),
      ]),
    ).toBe("Approve the external side effect?");
  });

  test("a wait event without a question records null (the honest no-detail note)", () => {
    const bare: ExecutionEvent = { ...waitEvent("x"), payload: {} };
    expect(waitQuestion([...events("execution.created"), bare])).toBeNull();
  });

  test("no wait event at all records null", () => {
    expect(waitQuestion(events("execution.created", "execution.start"))).toBeNull();
  });
});

describe("the wait decision surface (consequence + return-to-work)", () => {
  test("renders the recorded question, both consequences and the return-to-work link", () => {
    const html = resultSurface({
      execution: execution("WAITING_USER"),
      result: result("WAITING_USER", []),
      events: [...events("execution.created"), waitEvent("Approve the external side effect?")],
    });
    expect(html).toContain("Decision needed");
    expect(html).toContain("Approve the external side effect?");
    expect(html).toContain("What deciding means");
    expect(html).toContain("What cancelling means");
    expect(html).toContain("does not expose a resolve command");
    expect(html).toContain("Return to your work");
    expect(html).toContain("?action=cancel");
  });

  test("without a recorded question the honest no-detail note renders (never a guess)", () => {
    const html = resultSurface({
      execution: execution("WAITING_HUMAN"),
      result: result("WAITING_HUMAN", []),
      events: events("execution.created", "execution.wait-human"),
    });
    expect(html).toContain("No detail is recorded on the public wait event");
    expect(html).not.toContain("?&quot;");
  });
});

// ---------------------------------------------------------------------------
// AC2: the composer's attachment parsing
// ---------------------------------------------------------------------------

describe("parseAttachmentRefs (the one live secondary affordance)", () => {
  test("newlines and commas both separate; blanks collapse", () => {
    expect(parseAttachmentRefs("art-1\nart-2, art-3\n\n  \n")).toEqual(["art-1", "art-2", "art-3"]);
  });

  test("empty input is an empty list (the field is optional)", () => {
    expect(parseAttachmentRefs("")).toEqual([]);
    expect(parseAttachmentRefs("   \n ")).toEqual([]);
  });

  test("a token with spaces or hostile punctuation is rejected (null), never silently dropped", () => {
    expect(parseAttachmentRefs("good\n<script>alert(1)</script>")).toBeNull();
    expect(parseAttachmentRefs("has space")).toBeNull();
  });

  test("the builder maps validated attachments to inputArtifactRefs on the closed create request", () => {
    const { values, errors } = validateExecutionForm({
      applicationId: "app-1",
      outcome: "Summarize the findings",
      attachments: "art-1\nart-2",
    });
    expect(errors).toEqual({});
    if (values === null) {
      throw new Error("values must be non-null when errors is empty");
    }
    const request = buildExecutionRequest(values);
    expect(request.inputArtifactRefs).toEqual(["art-1", "art-2"]);
  });
});

// ---------------------------------------------------------------------------
// AC7: the WhyPanel's §11 answers
// ---------------------------------------------------------------------------

describe("WhyPanel answers the v2 §11 questions (each a fact or an honest absence)", () => {
  const view = {
    execution: execution("COMPLETED"),
    result: result("COMPLETED", [check("PASS", 1)]),
    events: events("execution.created", "execution.plan", "execution.pass"),
  };

  test("all seven questions are present as sections", () => {
    const html = whyPanel(view);
    expect(html).toContain("what did Zeck understand?");
    expect(html).toContain("What capabilities were required?");
    expect(html).toContain("what approach did Zeck choose?");
    expect(html).toContain("Why was that approach permitted?");
    expect(html).toContain("why was this route selected?");
    expect(html).toContain("What did Zeck deliberately avoid?");
    expect(html).toContain("How was the result verified?");
  });

  test("the deliberately-avoided answer states the create-contract fact, not an invented avoidance list", () => {
    const html = whyPanel(view);
    expect(html).toContain("The request selected no provider, model, rail, connection or agent");
    expect(html).toContain("which this projection does not carry");
  });

  test("the verification answer links to the Evidence view", () => {
    const html = whyPanel(view);
    expect(html).toContain("1 of 1 checks passed");
    expect(html).toContain('href="/runs/00000000-0000-7000-8000-0000000000e1?tab=evidence"');
  });

  test("the permitted answer carries the policy axis fact", () => {
    const html = whyPanel(view);
    expect(html).toContain("Admitted by policy");
  });
});
