/**
 * Dashboard inspection-presentation tests (WORK-040).
 *
 * The ONE advanced-inspection and multimodal presentation module
 * (inspection.ts): the Inspection view (the recorded planning decision —
 * selected approach first, policy/capability/sufficiency explanations,
 * candidates and substrate inside advanced disclosure, the integrity
 * anchor, the events/lineage/audit cross-links), the computer-use
 * section (the access-mode envelope, the isolation verdict, the
 * approval/risk story, the recorded denials verbatim), the
 * realtime/messaging section (the Deployment/Session/Execution
 * distinction + the session provenance), the media section (the job
 * lifecycle, digest-only lineage, verification/retry state), the edge
 * section (the local-safety boundary sentence, the honest absences), the
 * training section (the workload facts, checkpoints as advanced detail,
 * the no-release-claim boundary), the economic section (the four-axis
 * separation + the provenance timeline, the envelope's honest absence),
 * the modality composition (only-present sections) and the deployments
 * surface's availability distinction.
 *
 * Mutant-style pins (the W039 discipline): a UI-only value mistaken for
 * platform truth FAILS here — a fabricated planning decision, an
 * invented access envelope fact, a cloud-owned safety claim, a guessed
 * economic envelope value or a release-claiming training row each
 * differ from the honest rendering on the same input.
 */

import { describe, expect, test } from "vitest";
import {
  COMPUTER_USE_MODE_LABELS,
  computerUseSection,
  deploymentSessionExecutionSection,
  economicAxisRows,
  economicSection,
  edgeSection,
  inspectionPanel,
  mediaSection,
  modalitySections,
  realtimeMessagingSection,
  trainingDetailSection,
} from "../../../apps/dashboard/inspection";
import {
  agentSessionFactsOf,
  computerUseFactsOf,
  economicFactsOf,
  edgeFactsOf,
  mediaFactsOf,
  planningDecisionOf,
  trainingFactsOf,
} from "../../../apps/dashboard/projection";
import type { ExecutionEvent } from "../../../sdk";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000j1";
const RUN_HREF = `/runs/${EXECUTION_ID}`;

function eventOf(type: string, payload: Record<string, unknown> = {}): ExecutionEvent {
  return {
    eventId: `ev-${type}-${Object.keys(payload).length}`,
    executionId: EXECUTION_ID,
    type,
    sequence: 1,
    occurredAt: "2026-09-15T12:00:05Z",
    payload,
  };
}

/** The real planner's decision-record payload (field-complete). */
const DECISION_PAYLOAD = {
  decisionId: "decision-40",
  plannerVersion: "1.4.2",
  taskProfile: {
    kind: "extraction",
    riskLevel: "moderate",
    qualityTarget: 0.9,
    maxCostMicroUsd: "4000000",
    maxLatencyMs: 60000,
    requiresSemanticReasoning: true,
  },
  policyInputs: { outcome: "allow", policySetId: "policy-set-7", policySetVersion: 3 },
  capabilityResolution: {
    satisfied: true,
    catalogRevision: "rev-42",
    satisfiedIds: ["cap-a", "cap-b"],
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
    workloadClass: "batch",
    admissible: [
      {
        substrateId: "batch-compute-1",
        version: "2.1.0",
        adapterRef: "adapter.batch.compute",
        resource: {
          cpuMilliCores: 4000,
          memoryMiB: 8192,
          estimatedDurationMs: 30000,
          estimatedCostMicroUsd: "1800000",
        },
        isolation: "process-isolated",
        latencyClass: "batch",
      },
    ],
    inadmissible: [
      {
        substrateId: "batch-compute-2",
        version: "1.0.0",
        reason: "cost-above-ceiling",
        detail: "above the ceiling",
      },
    ],
    selected: { substrateId: "batch-compute-1", version: "2.1.0" },
    rationale: "the only in-ceiling batch candidate",
  },
  recordedAt: "2026-09-15T12:00:07Z",
  recordDigest: "sha256:decision-40",
} as unknown as Record<string, unknown>;

function decisionEvents(payload: Record<string, unknown> = DECISION_PAYLOAD): ExecutionEvent[] {
  return [eventOf("planning.decision-recorded", payload)];
}

// ---------------------------------------------------------------------------
// The Inspection view (AC1)
// ---------------------------------------------------------------------------

describe("inspectionPanel (the expert inspection view)", () => {
  test("renders the recorded decision: outcome first, internals in disclosure", () => {
    const html = inspectionPanel({
      executionId: EXECUTION_ID,
      environmentId: "env-2",
      decision: planningDecisionOf(decisionEvents()),
    });
    // The selected approach renders at the top (outcome first, IR2).
    expect(html).toContain("Inspection");
    expect(html).toContain("strategy-deterministic");
    expect(html).toContain("deterministic-first preference applied");
    // The explanation level: policy, capabilities, sufficiency.
    expect(html).toContain("Effective policy at admission");
    expect(html).toContain("policy-set-7");
    expect(html).toContain("Capability resolution");
    expect(html).toContain("rev-42");
    expect(html).toContain("Deterministic-first sufficiency");
    // The internals sit inside the collapsed disclosures.
    expect(html).toContain("<details");
    expect(html).toContain("Candidate strategies and subgraph evidence (advanced)");
    expect(html).toContain("strategy-hybrid");
    expect(html).toContain("policy-cost-ceiling");
    expect(html).toContain("Admissible substrate candidates (advanced)");
    expect(html).toContain("batch-compute-1");
    expect(html).toContain("cost-above-ceiling");
    // The integrity anchor and the cross-links (AC1: events/lineage/audit).
    expect(html).toContain("sha256:decision-40");
    expect(html).toContain(`href="${RUN_HREF}?tab=activity&amp;view=events"`);
    expect(html).toContain(`href="${RUN_HREF}?tab=activity&amp;view=raw"`);
    expect(html).toContain('href="/trust/lineage"');
    expect(html).toContain('href="/admin/audit"');
    expect(html).toContain("env-2");
  });

  test("no recorded decision renders the honest absence — never a fabricated one (D23)", () => {
    const html = inspectionPanel({
      executionId: EXECUTION_ID,
      environmentId: null,
      decision: null,
    });
    expect(html).toContain("No planning decision recorded");
    expect(html).not.toContain("strategy-deterministic");
    expect(html).not.toContain("policy-set-7");
    expect(html).toContain("default");
    expect(html).toContain(`href="${RUN_HREF}?tab=activity&amp;view=events"`);
  });

  test("the tab never changes the default flows: no mutation affordance exists (IR3)", () => {
    const html = inspectionPanel({
      executionId: EXECUTION_ID,
      environmentId: null,
      decision: planningDecisionOf(decisionEvents()),
    });
    expect(html).not.toContain("<form");
    expect(html).not.toContain('method="post"');
  });
});

// ---------------------------------------------------------------------------
// The computer-use section (AC2)
// ---------------------------------------------------------------------------

describe("computerUseSection (the access/risk envelope)", () => {
  const facts = computerUseFactsOf([
    eventOf("execution.tool-requested", {
      sessionId: "cu-1",
      phase: "session-admitted",
      mode: "browser",
      deterministicFirst: true,
      routeStageCount: 2,
    }),
    eventOf("execution.tool-result", {
      sessionId: "cu-1",
      phase: "environment-opened",
      mode: "browser",
      environmentRef: "env-9",
      inheritedHostStateCount: 0,
    }),
    eventOf("execution.tool-denied", {
      denied: true,
      denialClass: "policy",
      code: "POLICY_DENIED",
      reason: "the requested desktop access exceeds the effective policy envelope",
    }),
  ]);

  test("renders the access modes (the platform's vocabulary), the isolation verdict and the session history", () => {
    const html = computerUseSection({ executionId: EXECUTION_ID, facts });
    expect(html).toContain("Computer use");
    for (const mode of Object.keys(COMPUTER_USE_MODE_LABELS)) {
      expect(html).toContain(mode);
    }
    expect(html).toContain("cu-1");
    expect(html).toContain("env-9");
    expect(html).toContain("Filesystem and network constraints (advanced)");
    // The approval/risk story renders BEFORE consequential interaction.
    expect(html).toContain("Approval and risk before consequential interaction");
    // The denial reason renders verbatim (the platform's own words).
    expect(html).toContain("the requested desktop access exceeds the effective policy envelope");
    expect(html).toContain("POLICY_DENIED");
  });

  test("the section renders NO computer-use action (no mutation anywhere — IR3)", () => {
    const html = computerUseSection({ executionId: EXECUTION_ID, facts });
    expect(html).not.toContain("<form");
    expect(html).not.toContain('method="post"');
    expect(html).toContain("This section never issues a computer-use action");
  });
});

// ---------------------------------------------------------------------------
// The realtime/messaging section (AC3)
// ---------------------------------------------------------------------------

describe("realtimeMessagingSection (Deployment / Session / Execution)", () => {
  const facts = agentSessionFactsOf([
    eventOf("execution.agent-session-started", {
      callerRef: "caller-77",
      railCapabilityId: "rail-realtime-1",
    }),
    eventOf("execution.agent-action-recorded", {
      routeClass: "realtime-turn",
      plannerOutcome: "routed",
      reasonCodes: ["policy-allowed"],
    }),
    eventOf("execution.agent-session-completed", {}),
  ]);

  test("renders the three distinct levels and the session provenance", () => {
    const html = realtimeMessagingSection({ executionId: EXECUTION_ID, facts });
    expect(html).toContain("Realtime and messaging sessions");
    expect(html).toContain("Deployment");
    expect(html).toContain("Session");
    expect(html).toContain("Execution");
    expect(html).toContain("caller-77");
    expect(html).toContain("rail-realtime-1");
    expect(html).toContain("realtime-turn");
    expect(html).toContain("Session started");
    expect(html).toContain("Session completed");
  });

  test("every session fact links back to the canonical run (AC9)", () => {
    const html = realtimeMessagingSection({ executionId: EXECUTION_ID, facts });
    expect(html).toContain(`href="${RUN_HREF}"`);
    expect(html).toContain('href="/deployments"');
  });
});

// ---------------------------------------------------------------------------
// The media section (AC4)
// ---------------------------------------------------------------------------

describe("mediaSection (asynchronous work, lineage, verification, retry)", () => {
  const facts = mediaFactsOf([
    eventOf("execution.agent-session-started", {
      verificationMode: "required",
      inputArtifactDigest: "sha256:in-1",
    }),
    eventOf("execution.agent-action-recorded", {
      role: "generated-output",
      descriptorDigest: "sha256:out-1",
    }),
    eventOf("execution.agent-session-completed", {
      generationKind: "image",
      verifiedByAuthority: true,
    }),
  ]);

  test("renders the job lifecycle with digest references and the verification state", () => {
    const html = mediaSection({ executionId: EXECUTION_ID, status: "COMPLETED", facts });
    expect(html).toContain("Media generation");
    expect(html).toContain("job-submitted");
    expect(html).toContain("sha256:in-1");
    expect(html).toContain("artifact");
    expect(html).toContain("sha256:out-1");
    expect(html).toContain("job-completed");
    expect(html).toContain("image");
    expect(html).toContain("verified by the verification authority");
    expect(html).toContain("COMPLETED");
  });

  test("lineage is digest references ONLY — no media content rides the ledger", () => {
    const html = mediaSection({ executionId: EXECUTION_ID, status: "RUNNING", facts });
    expect(html).toContain("digest references only");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:image");
  });
});

// ---------------------------------------------------------------------------
// The edge section (AC6)
// ---------------------------------------------------------------------------

describe("edgeSection (the local safety boundary)", () => {
  const decision = planningDecisionOf([
    eventOf("planning.decision-recorded", {
      ...DECISION_PAYLOAD,
      substrateSelection: {
        outcome: "selected",
        workloadClass: "embodied",
        admissible: [
          {
            substrateId: "embodied-1",
            version: "3.0.0",
            resource: { cpuMilliCores: 2000, memoryMiB: 4096 },
            isolation: "hardware-isolated",
            latencyClass: "realtime",
          },
        ],
        inadmissible: [],
        selected: { substrateId: "embodied-1", version: "3.0.0" },
        rationale: "the only hardware-isolated candidate",
      },
    } as Record<string, unknown>),
  ]);
  const facts = edgeFactsOf(decision);

  test("renders the boundary sentence and the workload-class evidence", () => {
    const html = edgeSection({ executionId: EXECUTION_ID, facts });
    expect(html).toContain("Edge / embodied work");
    expect(html).toContain("embodied");
    expect(html).toContain("embodied-1");
    expect(html).toContain("hardware-isolated");
    expect(html).toContain("Hard-real-time safety authority stays LOCAL");
    expect(html).toContain("never owns, implies or issues real-time control");
  });

  test("the current physical command and local safety state are honest absences (never fabricated)", () => {
    const html = edgeSection({ executionId: EXECUTION_ID, facts });
    expect(html).toContain("Current physical command");
    expect(html).toContain("does not cross the public wire");
    expect(html).toContain("Local safety state");
    expect(html).toContain("owned locally by the edge substrate");
    // No cloud-control affordance exists (the forbidden cloud UI): the
    // boundary sentence itself is the proof, and no form or POST exists.
    expect(html).toContain("No command, actuation or override exists on this page");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('method="post"');
  });
});

// ---------------------------------------------------------------------------
// The training section (AC7)
// ---------------------------------------------------------------------------

describe("trainingDetailSection (resource selection, checkpoints, no release claim)", () => {
  const facts = trainingFactsOf([
    eventOf("execution.sandbox-admitted", {
      workloadId: "tw-1",
      workloadKey: "workload-key-1",
      workloadKind: "fine-tune",
      status: "running",
      attempt: 1,
    }),
    eventOf("execution.checkpoint-recorded", {
      checkpointIdentity: "cp-1",
      checkpointSequence: 1,
      stepPosition: 1200,
      metricsDigest: "sha256:metrics-1",
    }),
    eventOf("execution.sandbox-completed", {
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

  test("renders the workload facts with the checkpoints as advanced detail", () => {
    const html = trainingDetailSection({ executionId: EXECUTION_ID, facts });
    expect(html).toContain("Training / accelerator work");
    expect(html).toContain("tw-1");
    expect(html).toContain("fine-tune");
    expect(html).toContain("workload-completed");
    expect(html).toContain("Resource selection and checkpoints (advanced)");
    expect(html).toContain("sha256:metrics-1");
    expect(html).toContain("$2.50");
  });

  test("the four states stay distinct — no release claim, ever (AC7)", () => {
    const html = trainingDetailSection({ executionId: EXECUTION_ID, facts });
    // The boundary sentence names the four states as DISTINCT and states
    // this surface never claims release — no row ever marks release.
    expect(html).toContain("never claims release");
    expect(html).toContain("four DISTINCT states");
    expect(html).not.toContain('distinction-state">Release approved');
    expect(html).not.toContain('"compute-complete"');
  });
});

// ---------------------------------------------------------------------------
// The economic section (AC8)
// ---------------------------------------------------------------------------

describe("economicSection (the four-axis separation)", () => {
  const facts = economicFactsOf([
    eventOf("execution.economic-action-recorded", { economicActionId: "ea-1" }),
    eventOf("execution.economic-action-authorized", { economicActionId: "ea-1" }),
    eventOf("execution.economic-action-settled", { economicActionId: "ea-1" }),
  ]);

  test("renders the four separate axes and the provenance timeline", () => {
    const html = economicSection({ executionId: EXECUTION_ID, facts });
    expect(html).toContain("Economic actions");
    expect(html).toContain("Bounded intent");
    expect(html).toContain("Authorization");
    expect(html).toContain("Settlement");
    expect(html).toContain("Resource / outcome verification");
    expect(html).toContain("ea-1");
    expect(html).toContain("recorded");
    expect(html).toContain("authorized");
    expect(html).toContain("settled");
    expect(economicAxisRows()).toHaveLength(4);
  });

  test("the bounded envelope is the honest absence — never a fabricated value (D26)", () => {
    const html = economicSection({ executionId: EXECUTION_ID, facts });
    expect(html).toContain("do not cross the public execution wire");
    expect(html).not.toContain("$");
    expect(html).not.toContain("recipient:");
    expect(html).not.toContain("expires");
  });

  test("no client-side payment authorization exists anywhere (the forbidden list)", () => {
    const html = economicSection({ executionId: EXECUTION_ID, facts });
    expect(html).not.toContain("<form");
    expect(html).not.toContain('method="post"');
    expect(html).toContain("renders no economic action");
  });
});

// ---------------------------------------------------------------------------
// The modality composition (AC9 — only-present sections)
// ---------------------------------------------------------------------------

describe("modalitySections (the contextual composition)", () => {
  test("a run with NO modality events renders NO sections (D24)", () => {
    const html = modalitySections({
      executionId: EXECUTION_ID,
      status: "COMPLETED",
      environmentId: null,
      computerUse: computerUseFactsOf([eventOf("execution.created")]),
      agentSessions: agentSessionFactsOf([eventOf("execution.created")]),
      media: mediaFactsOf([eventOf("execution.created")]),
      edge: edgeFactsOf(null),
      training: trainingFactsOf([eventOf("execution.created")]),
      economic: economicFactsOf([eventOf("execution.created")]),
    });
    expect(html).not.toContain("modality-section");
    expect(html).not.toContain("Computer use");
    expect(html).not.toContain("Economic actions");
  });

  test("each present modality renders and links back to the run (AC9)", () => {
    const html = modalitySections({
      executionId: EXECUTION_ID,
      status: "RUNNING",
      environmentId: null,
      computerUse: computerUseFactsOf([
        eventOf("execution.tool-requested", { sessionId: "cu-1", mode: "browser" }),
      ]),
      agentSessions: agentSessionFactsOf([
        eventOf("execution.agent-session-started", { callerRef: "caller-1" }),
      ]),
      media: mediaFactsOf([
        eventOf("execution.agent-session-completed", { generationKind: "image" }),
      ]),
      edge: edgeFactsOf(
        planningDecisionOf([
          eventOf("planning.decision-recorded", {
            ...DECISION_PAYLOAD,
            substrateSelection: {
              outcome: "selected",
              workloadClass: "edge",
              admissible: [],
              inadmissible: [],
              selected: { substrateId: "edge-1", version: "1.0.0" },
              rationale: "",
            },
          } as Record<string, unknown>),
        ]),
      ),
      training: trainingFactsOf([
        eventOf("execution.sandbox-admitted", { workloadId: "tw-1", workloadKind: "fine-tune" }),
      ]),
      economic: economicFactsOf([
        eventOf("execution.economic-action-recorded", { economicActionId: "ea-1" }),
      ]),
    });
    expect(html).toContain("Computer use");
    expect(html).toContain("Realtime and messaging sessions");
    expect(html).toContain("Media generation");
    expect(html).toContain("Edge / embodied work");
    expect(html).toContain("Training / accelerator work");
    expect(html).toContain("Economic actions");
    expect(html).toContain(`href="${RUN_HREF}"`);
  });
});

// ---------------------------------------------------------------------------
// The deployments surface extension (AC3)
// ---------------------------------------------------------------------------

describe("deploymentSessionExecutionSection (the availability distinction)", () => {
  test("renders the three levels with the live session rows", () => {
    const html = deploymentSessionExecutionSection({
      sessionRuns: [
        { executionId: EXECUTION_ID, sessionCount: 2, lastActivity: "2026-09-15T12:03:00Z" },
      ],
    });
    expect(html).toContain("Availability and the governed work behind it");
    expect(html).toContain("Deployment");
    expect(html).toContain("Session");
    expect(html).toContain("Execution");
    expect(html).toContain(`href="${RUN_HREF}"`);
    expect(html).toContain("2");
  });

  test("no session evidence renders the honest empty state (never a fabricated availability)", () => {
    const html = deploymentSessionExecutionSection({ sessionRuns: [] });
    // The empty-state title is HTML-escaped (the apostrophe renders as
    // &#39;) — the escaped form is the pinned rendering.
    expect(html).toContain("No session evidence in this browser&#39;s scope");
    expect(html).not.toContain("<table");
  });
});
