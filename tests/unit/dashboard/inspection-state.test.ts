/**
 * Dashboard inspection-state tests (WORK-040).
 *
 * The advanced-inspection and modality state fixtures — the honest
 * derivation table for the expert inspection and the multimodal
 * surfaces. Mutant-style pins (the W039 discipline): a UI-only value
 * mistaken for platform truth FAILS here — a fabricated planning
 * decision, an invented computer-use envelope fact, a guessed economic
 * bounded amount, or a media/training fact read from the wrong payload
 * each differ from the honest derivation on the same input.
 *
 * The fixtures (the Work Order's Required Verification):
 *  - expert inspection: the planning decision is the LAST recorded
 *    `planning.decision-recorded` payload, field by field — never
 *    status-derived, never canned (D23);
 *  - modality facts: computer-use, agent-session, media, training and
 *    economic facts come ONLY from the payloads that carry their own
 *    vocabulary — a lifecycle event never produces a modality fact
 *    (D24);
 *  - the step-event vocabulary: the real wire's prefixed types
 *    (`execution.checkpoint-recorded`, …) and the recorded fixture
 *    spellings normalize to ONE command vocabulary;
 *  - the economic envelope: the public payload carries the
 *    economicActionId ONLY — the bounded envelope is never guessed
 *    (D26).
 */

import { describe, expect, test } from "vitest";
import {
  agentSessionFactsOf,
  computerUseFactsOf,
  deriveWorkloadFacts,
  economicFactsOf,
  edgeFactsOf,
  mediaFactsOf,
  normalizeStepEventType,
  planningDecisionOf,
  trainingFactsOf,
} from "../../../apps/dashboard/projection";
import type { ExecutionEvent } from "../../../sdk";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000i1";

function eventOf(
  type: string,
  sequence: number,
  payload: Record<string, unknown> = {},
): ExecutionEvent {
  return {
    eventId: `ev-${EXECUTION_ID}-${sequence}`,
    executionId: EXECUTION_ID,
    type,
    sequence,
    occurredAt: "2026-09-15T12:00:05Z",
    payload,
  };
}

/** The real planner's own decision-record payload shape (field-complete). */
const DECISION_PAYLOAD = {
  decisionId: "decision-1",
  executionId: EXECUTION_ID,
  plannerVersion: "1.4.2",
  taskProfile: {
    profileDigest: "sha256:abc",
    kind: "extraction",
    input: { description: "Extract the tables" },
    riskLevel: "moderate",
    qualityTarget: 0.9,
    maxCostMicroUsd: "4000000",
    maxLatencyMs: 60000,
    requiresSemanticReasoning: true,
  },
  policyInputs: {
    outcome: "allow",
    policySetId: "policy-set-7",
    policySetVersion: 3,
  },
  capabilityResolution: {
    satisfied: true,
    catalogRevision: "rev-42",
    satisfiedIds: ["cap-extraction", "cap-verify"],
    unmetIds: [],
  },
  deterministicSufficiency: {
    outcome: "insufficient",
    semanticReasoningRequired: true,
    deterministicQualityEstimate: 0.62,
  },
  candidates: [
    {
      strategyId: "strategy-deterministic",
      plan: { planId: "plan-1" },
      expectedCostMicroUsd: "500000",
      expectedQuality: 0.62,
      expectedLatencyMs: 9000,
      verificationStrategy: "digest-check",
      routeRationale: { code: "deterministic-quality-gap", detail: "below the target" },
      modelCalls: 0,
      admissible: true,
    },
    {
      strategyId: "strategy-hybrid",
      plan: { planId: "plan-2" },
      expectedCostMicroUsd: "3100000",
      expectedQuality: 0.93,
      expectedLatencyMs: 21000,
      verificationStrategy: "digest-check",
      routeRationale: { code: "semantic-reasoning-required", detail: "the task requires it" },
      modelCalls: 3,
      admissible: false,
      inadmissibleReason: "policy-cost-ceiling",
    },
  ],
  selectedStrategyId: "strategy-deterministic",
  selectionRationale: "deterministic-first preference applied",
  subgraphEvidence: [{ observationId: "obs-1" }, { observationId: "obs-2" }],
  substrateSelection: {
    outcome: "selected",
    workloadClass: "edge",
    admissible: [
      {
        substrateId: "edge-compute-1",
        version: "2.1.0",
        adapterRef: "adapter.edge.compute",
        resource: {
          cpuMilliCores: 4000,
          memoryMiB: 8192,
          estimatedDurationMs: 30000,
          estimatedCostMicroUsd: "1800000",
        },
        isolation: "hardware-isolated",
        latencyClass: "realtime",
      },
    ],
    inadmissible: [
      {
        substrateId: "edge-compute-2",
        version: "1.0.0",
        reason: "isolation-below-policy",
        detail: "the policy requires hardware isolation for this workload class",
      },
    ],
    selected: { substrateId: "edge-compute-1", version: "2.1.0" },
    rationale: "the only hardware-isolated realtime candidate",
    after: {
      policyInputsCaptured: true,
      capabilityResolutionCaptured: true,
      deterministicSufficiencyApplied: true,
    },
  },
  recordedAt: "2026-09-15T12:00:07Z",
  recordDigest: "sha256:def",
} as unknown as Record<string, unknown>;

// ---------------------------------------------------------------------------
// The step-event vocabulary (the real wire's prefixed types normalize)
// ---------------------------------------------------------------------------

describe("the step-event type normalization", () => {
  test("the real wire's prefixed step types normalize to the command", () => {
    expect(normalizeStepEventType("execution.checkpoint-recorded")).toBe("checkpoint-recorded");
    expect(normalizeStepEventType("execution.tool-requested")).toBe("tool-requested");
    expect(normalizeStepEventType("execution.agent-session-started")).toBe("agent-session-started");
    expect(normalizeStepEventType("execution.economic-action-authorized")).toBe(
      "economic-action-authorized",
    );
  });

  test("lifecycle and unknown types stay verbatim (never a second vocabulary)", () => {
    expect(normalizeStepEventType("execution.created")).toBe("execution.created");
    expect(normalizeStepEventType("execution.start")).toBe("execution.start");
    expect(normalizeStepEventType("planning.decision-recorded")).toBe("planning.decision-recorded");
    expect(normalizeStepEventType("checkpoint-recorded")).toBe("checkpoint-recorded");
    expect(normalizeStepEventType("something.else")).toBe("something.else");
  });

  test("the real wire's prefixed checkpoint events light the long-running view", () => {
    const facts = deriveWorkloadFacts([
      eventOf("execution.created", 1),
      eventOf("execution.start", 2),
      eventOf("execution.checkpoint-recorded", 3, {
        checkpointSequence: 1,
        lastEventPosition: 4200,
      }),
      eventOf("execution.resume-recorded", 4),
    ]);
    expect(facts.present).toBe(true);
    expect(facts.checkpointCount).toBe(1);
    expect(facts.lastCheckpoint?.sequence).toBe(1);
    expect(facts.recovery?.kind).toBe("recovered");
  });
});

// ---------------------------------------------------------------------------
// The expert-inspection derivation (D23 — the recorded decision only)
// ---------------------------------------------------------------------------

describe("planningDecisionOf (the recorded planning decision)", () => {
  test("reads the last recorded decision payload field by field", () => {
    const events = [
      eventOf("execution.created", 1),
      eventOf("planning.decision-recorded", 2, DECISION_PAYLOAD),
    ];
    const decision = planningDecisionOf(events);
    expect(decision).not.toBeNull();
    expect(decision?.decisionId).toBe("decision-1");
    expect(decision?.plannerVersion).toBe("1.4.2");
    expect(decision?.riskLevel).toBe("moderate");
    expect(decision?.qualityTarget).toBe(0.9);
    expect(decision?.maxCostMicroUsd).toBe("4000000");
    expect(decision?.policyOutcome).toBe("allow");
    expect(decision?.policySetId).toBe("policy-set-7");
    expect(decision?.policySetVersion).toBe("3");
    expect(decision?.capabilitySatisfied).toBe(true);
    expect(decision?.capabilityCatalogRevision).toBe("rev-42");
    expect(decision?.satisfiedCapabilityCount).toBe(2);
    expect(decision?.unmetCapabilityIds).toEqual([]);
    expect(decision?.sufficiencyOutcome).toBe("insufficient");
    expect(decision?.deterministicQualityEstimate).toBe(0.62);
    expect(decision?.selectedStrategyId).toBe("strategy-deterministic");
    expect(decision?.selectionRationale).toBe("deterministic-first preference applied");
    expect(decision?.subgraphEvidenceCount).toBe(2);
    expect(decision?.recordDigest).toBe("sha256:def");
    expect(decision?.candidates).toHaveLength(2);
    expect(decision?.candidates[0]?.admissible).toBe(true);
    expect(decision?.candidates[1]?.admissible).toBe(false);
    expect(decision?.candidates[1]?.inadmissibleReason).toBe("policy-cost-ceiling");
    expect(decision?.substrate?.outcome).toBe("selected");
    expect(decision?.substrate?.workloadClass).toBe("edge");
    expect(decision?.substrate?.selectedSubstrateId).toBe("edge-compute-1");
    expect(decision?.substrate?.admissible[0]?.cpuMilliCores).toBe(4000);
    expect(decision?.substrate?.inadmissible[0]?.reason).toBe("isolation-below-policy");
  });

  test("no decision event ⇒ null (never status-derived, never canned — D23)", () => {
    expect(
      planningDecisionOf([
        eventOf("execution.created", 1),
        eventOf("execution.authorize", 2),
        eventOf("execution.start", 3),
      ]),
    ).toBeNull();
    expect(planningDecisionOf([])).toBeNull();
  });

  test("missing or wrong-shaped fields stay null (never a guess)", () => {
    const decision = planningDecisionOf([
      eventOf("planning.decision-recorded", 1, { decisionId: "d" }),
    ]);
    expect(decision?.decisionId).toBe("d");
    expect(decision?.plannerVersion).toBeNull();
    expect(decision?.riskLevel).toBeNull();
    expect(decision?.qualityTarget).toBeNull();
    expect(decision?.policyOutcome).toBeNull();
    expect(decision?.candidates).toEqual([]);
    expect(decision?.substrate).toBeNull();
    expect(decision?.subgraphEvidenceCount).toBe(0);
  });

  test("the LAST decision wins (a replan supersedes the original)", () => {
    const events = [
      eventOf("planning.decision-recorded", 1, { decisionId: "d-1", selectedStrategyId: "s-1" }),
      eventOf("planning.decision-recorded", 2, { decisionId: "d-2", selectedStrategyId: "s-2" }),
    ];
    const decision = planningDecisionOf(events);
    expect(decision?.decisionId).toBe("d-2");
    expect(decision?.selectedStrategyId).toBe("s-2");
  });
});

// ---------------------------------------------------------------------------
// The computer-use derivation (D24 — the tool-axis payload vocabulary)
// ---------------------------------------------------------------------------

describe("computerUseFactsOf (the computer-use envelope facts)", () => {
  test("reads the session and denial payload facts exactly as recorded", () => {
    const facts = computerUseFactsOf([
      eventOf("execution.created", 1),
      eventOf("execution.tool-requested", 2, {
        sessionId: "cu-1",
        phase: "session-admitted",
        mode: "browser",
        deterministicFirst: true,
        routeStageCount: 2,
      }),
      eventOf("execution.tool-result", 3, {
        sessionId: "cu-1",
        phase: "environment-opened",
        mode: "browser",
        environmentRef: "env-9",
        inheritedHostStateCount: 0,
      }),
      eventOf("execution.tool-denied", 4, {
        denied: true,
        denialClass: "policy",
        code: "POLICY_DENIED",
        reason: "the requested desktop access exceeds the effective policy envelope",
      }),
    ]);
    expect(facts.present).toBe(true);
    expect(facts.sessions).toHaveLength(2);
    expect(facts.sessions[0]?.mode).toBe("browser");
    expect(facts.sessions[1]?.phase).toBe("environment-opened");
    expect(facts.sessions[1]?.environmentRef).toBe("env-9");
    expect(facts.sessions[1]?.inheritedHostStateCount).toBe(0);
    expect(facts.denials).toHaveLength(1);
    expect(facts.denials[0]?.code).toBe("POLICY_DENIED");
    expect(facts.denials[0]?.reason).toBe(
      "the requested desktop access exceeds the effective policy envelope",
    );
  });

  test("non-computer-use tool events contribute nothing (D24)", () => {
    const facts = computerUseFactsOf([
      eventOf("execution.created", 1),
      eventOf("execution.tool-result", 2, { toolId: "tool-7", outcome: "ok" }),
      eventOf("execution.tool-requested", 3, { toolId: "tool-8" }),
    ]);
    expect(facts.present).toBe(false);
    expect(facts.sessions).toEqual([]);
    expect(facts.denials).toEqual([]);
  });

  test("lifecycle events never produce computer-use facts", () => {
    expect(computerUseFactsOf([eventOf("execution.start", 1)])).toEqual({
      sessions: [],
      denials: [],
      present: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The agent-session derivation (AC3 — realtime/messaging provenance)
// ---------------------------------------------------------------------------

describe("agentSessionFactsOf (the session provenance)", () => {
  test("collects the session lifecycle with the recorded payload keys", () => {
    const facts = agentSessionFactsOf([
      eventOf("execution.created", 1),
      eventOf("execution.agent-session-started", 2, {
        callerRef: "caller-77",
        railCapabilityId: "rail-realtime-1",
      }),
      eventOf("execution.agent-action-recorded", 3, {
        routeClass: "realtime-turn",
        plannerOutcome: "routed",
        reasonCodes: ["policy-allowed"],
        responsePreview: "Here is the summary…",
      }),
      eventOf("execution.agent-session-completed", 4, {}),
    ]);
    expect(facts.present).toBe(true);
    expect(facts.sessionCount).toBe(1);
    expect(facts.events).toHaveLength(3);
    expect(facts.events[0]?.stage).toBe("session-started");
    expect(facts.events[0]?.callerRef).toBe("caller-77");
    expect(facts.events[0]?.railCapabilityId).toBe("rail-realtime-1");
    expect(facts.events[1]?.stage).toBe("action");
    expect(facts.events[1]?.routeClass).toBe("realtime-turn");
    expect(facts.events[1]?.plannerOutcome).toBe("routed");
    expect(facts.events[2]?.stage).toBe("session-completed");
  });

  test("the messaging vocabulary (participantRef) reads identically", () => {
    const facts = agentSessionFactsOf([
      eventOf("execution.agent-session-started", 1, {
        participantRef: "participant-9",
        railCapabilityId: "rail-messaging-1",
      }),
    ]);
    expect(facts.events[0]?.participantRef).toBe("participant-9");
    expect(facts.events[0]?.callerRef).toBeNull();
  });

  test("no session events ⇒ not present", () => {
    expect(agentSessionFactsOf([eventOf("execution.created", 1)]).present).toBe(false);
    expect(agentSessionFactsOf([]).present).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The media derivation (AC4 — the media payload vocabulary only)
// ---------------------------------------------------------------------------

describe("mediaFactsOf (the media job facts)", () => {
  test("reads the media vocabulary: submitted, dispatched, artifact, completed", () => {
    const facts = mediaFactsOf([
      eventOf("execution.agent-session-started", 1, {
        verificationMode: "required",
        inputArtifactDigest: "sha256:in-1",
        railCapabilityId: "rail-media-1",
      }),
      eventOf("execution.agent-action-recorded", 2, {
        preprocessingDigest: "sha256:pre-1",
        providerStateLabel: "queued",
      }),
      eventOf("execution.agent-action-recorded", 3, {
        role: "generated-output",
        descriptorDigest: "sha256:out-1",
      }),
      eventOf("execution.agent-session-completed", 4, {
        generationKind: "image",
        postprocessingDigest: "sha256:post-1",
        verifiedByAuthority: true,
      }),
    ]);
    expect(facts.present).toBe(true);
    expect(facts.events).toHaveLength(4);
    expect(facts.events[0]?.stage).toBe("job-submitted");
    expect(facts.events[0]?.inputArtifactDigest).toBe("sha256:in-1");
    expect(facts.events[1]?.stage).toBe("job-dispatched");
    expect(facts.events[1]?.providerStateLabel).toBe("queued");
    expect(facts.events[2]?.stage).toBe("artifact");
    expect(facts.events[2]?.outputArtifactDigest).toBe("sha256:out-1");
    expect(facts.events[3]?.stage).toBe("job-completed");
    expect(facts.events[3]?.generationKind).toBe("image");
    expect(facts.events[3]?.verifiedByAuthority).toBe(true);
  });

  test("a realtime session (no media vocabulary) is NOT media (D24)", () => {
    const facts = mediaFactsOf([
      eventOf("execution.agent-session-started", 1, { callerRef: "caller-1" }),
      eventOf("execution.agent-action-recorded", 2, { routeClass: "realtime-turn" }),
    ]);
    expect(facts.present).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The training derivation (AC7 — the training payload vocabulary only)
// ---------------------------------------------------------------------------

describe("trainingFactsOf (the training workload facts)", () => {
  test("reads the workload vocabulary: admitted, checkpoints, completed", () => {
    const facts = trainingFactsOf([
      eventOf("execution.created", 1),
      eventOf("execution.sandbox-admitted", 2, {
        workloadId: "tw-1",
        workloadKey: "workload-key-1",
        workloadKind: "fine-tune",
        status: "running",
        attempt: 1,
        resource: { cpuMilliCores: 8000, memoryMiB: 16384 },
        lineage: { datasetDigest: "sha256:data-1" },
      }),
      eventOf("execution.checkpoint-recorded", 3, {
        checkpointIdentity: "cp-1",
        checkpointSequence: 1,
        stepPosition: 1200,
        metricsDigest: "sha256:metrics-1",
      }),
      eventOf("execution.sandbox-completed", 4, {
        workloadId: "tw-1",
        workloadKey: "workload-key-1",
        workloadKind: "fine-tune",
        status: "completed",
        attempt: 1,
        outcomeClass: "workload-completed",
        stepsCompleted: 4800,
        outputArtifactDigest: "sha256:model-1",
        usageMicroUsd: "2500000",
      }),
    ]);
    expect(facts.present).toBe(true);
    expect(facts.admitted).toBe(true);
    expect(facts.workloadId).toBe("tw-1");
    expect(facts.workloadKind).toBe("fine-tune");
    expect(facts.attempt).toBe(1);
    expect(facts.checkpoints).toHaveLength(1);
    expect(facts.checkpoints[0]?.metricsDigest).toBe("sha256:metrics-1");
    expect(facts.checkpoints[0]?.stepPosition).toBe(1200);
    expect(facts.outcomeClass).toBe("workload-completed");
    expect(facts.stepsCompleted).toBe(4800);
    expect(facts.outputArtifactDigest).toBe("sha256:model-1");
    expect(facts.usageMicroUsd).toBe("2500000");
  });

  test("the admission denial is its own recorded fact", () => {
    const facts = trainingFactsOf([
      eventOf("execution.sandbox-denied", 1, {
        workloadId: "tw-2",
        workloadKey: "workload-key-2",
        workloadKind: "fine-tune",
        status: "denied",
        attempt: 1,
        denied: true,
        denialClass: "budget",
        code: "BUDGET_EXCEEDED",
        reason: "the accelerator allocation exceeds the reserved budget",
      }),
    ]);
    expect(facts.present).toBe(true);
    expect(facts.denied).toBe(true);
    expect(facts.denialCode).toBe("BUDGET_EXCEEDED");
    expect(facts.admitted).toBe(false);
  });

  test("a non-training sandbox run and a long-running checkpoint contribute nothing (D24)", () => {
    const facts = trainingFactsOf([
      eventOf("execution.sandbox-admitted", 1, {
        sandboxId: "sb-1",
        environmentId: "env-1",
        kind: "code-exec",
        status: "dispatching",
      }),
      eventOf("execution.checkpoint-recorded", 2, {
        checkpointSequence: 1,
        lastEventPosition: 4200,
      }),
    ]);
    expect(facts.present).toBe(false);
    expect(facts.workloadId).toBeNull();
    expect(facts.checkpoints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The economic derivation (D26 — the provenance timeline only)
// ---------------------------------------------------------------------------

describe("economicFactsOf (the execution-bound provenance timeline)", () => {
  test("collects the five phases with the recorded action ids", () => {
    const facts = economicFactsOf([
      eventOf("execution.created", 1),
      eventOf("execution.economic-action-recorded", 2, { economicActionId: "ea-1" }),
      eventOf("execution.economic-action-authorized", 3, { economicActionId: "ea-1" }),
      eventOf("execution.economic-action-settled", 4, { economicActionId: "ea-1" }),
      eventOf("execution.economic-action-recorded", 5, { economicActionId: "ea-2" }),
      eventOf("execution.economic-action-failed", 6, { economicActionId: "ea-2" }),
    ]);
    expect(facts.present).toBe(true);
    expect(facts.timeline).toHaveLength(5);
    expect(facts.timeline.map((row) => row.phase)).toEqual([
      "recorded",
      "authorized",
      "settled",
      "recorded",
      "failed",
    ]);
    expect(facts.actionIds).toEqual(["ea-1", "ea-2"]);
  });

  test("the payload carries the action id ONLY — the envelope is never guessed (D26)", () => {
    const facts = economicFactsOf([
      eventOf("execution.economic-action-recorded", 1, { economicActionId: "ea-1" }),
    ]);
    expect(Object.keys(facts.timeline[0] ?? {})).not.toContain("purpose");
    expect(Object.keys(facts.timeline[0] ?? {})).not.toContain("amount");
    expect(Object.keys(facts.timeline[0] ?? {})).not.toContain("recipient");
  });

  test("non-economic events contribute nothing", () => {
    expect(economicFactsOf([eventOf("execution.created", 1)]).present).toBe(false);
    expect(economicFactsOf([]).present).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The edge derivation (AC6 — the workload-class evidence)
// ---------------------------------------------------------------------------

describe("edgeFactsOf (the edge/embodied boundary facts)", () => {
  test("an edge workload class surfaces the substrate's recorded characteristics", () => {
    const decision = planningDecisionOf([
      eventOf("planning.decision-recorded", 1, DECISION_PAYLOAD),
    ]);
    const facts = edgeFactsOf(decision);
    expect(facts.present).toBe(true);
    expect(facts.workloadClass).toBe("edge");
    expect(facts.substrateId).toBe("edge-compute-1");
    expect(facts.isolation).toBe("hardware-isolated");
    expect(facts.latencyClass).toBe("realtime");
  });

  test("a non-edge decision never surfaces edge facts", () => {
    const decision = planningDecisionOf([
      eventOf("planning.decision-recorded", 1, {
        ...DECISION_PAYLOAD,
        substrateSelection: {
          outcome: "no-substrate-required",
          workloadClass: null,
          admissible: [],
          inadmissible: [],
          selected: null,
          rationale: "",
        },
      } as Record<string, unknown>),
    ]);
    expect(edgeFactsOf(decision).present).toBe(false);
    expect(edgeFactsOf(null).present).toBe(false);
  });
});
