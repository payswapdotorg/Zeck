/**
 * Zeck dashboard advanced-inspection + multimodal presentation (WORK-040).
 *
 * THE ONE advanced-inspection and modality presentation vocabulary: every
 * route that renders an expert inspection fact or a modality-specific
 * operational fact — the run page's Inspection tab (plan, capabilities,
 * effective policy, route, compute substrate, events, lineage, audit),
 * the contextual modality sections (computer-use, realtime/messaging,
 * media, long-running, edge/embodied, training/accelerator, economic
 * actions) and the deployments surface's availability distinction —
 * composes THIS module, so the same semantic vocabulary (the
 * Deployment/Session/Execution distinction, the access-mode envelope,
 * the never-cloud-owned safety boundary, the intent → authorization →
 * settlement → delivery separation) appears everywhere and nowhere else
 * (Implementation Requirement 1).
 *
 * The honesty rules (the WORK-040 checkpoint contracts):
 *  - advanced views inspect existing facts; they never manufacture them:
 *    every fact below is the platform's own recorded event payload or
 *    result fact, read exactly as recorded — a missing field renders as
 *    its own absence, never a guess (the invariants);
 *  - no modality gets a second execution or policy semantics: the
 *    modality sections PROJECT the single canonical execution ledger —
 *    every one links back to the run context (AC9);
 *  - provider/runtime/rail identities are implementation detail: they
 *    render inside advanced disclosure unless a user decision needs them
 *    (IR4);
 *  - progressive disclosure (IR2): outcome first, explanation second,
 *    control third, internals fourth — deep internals (candidates,
 *    subgraph evidence, digests) sit inside collapsed disclosures;
 *  - for external side effects, consequence preview before commitment
 *    (IR3): this module renders NO mutation at all — the only governed
 *    mutations stay the create/cancel confirmation flows (WORK-035), so
 *    every modality surface is read-only by construction;
 *  - edge safety authority remains local (AC6): the boundary sentence —
 *    the cloud never owns a hard-real-time safety loop — renders on the
 *    edge surface; no cloud-control affordance exists;
 *  - economic intent, authorization, transaction, settlement and
 *    verification remain separate (AC8): the four-axis distinction
 *    renders with the live provenance timeline and the honest absence of
 *    the economics authority's own records.
 *
 * This module renders; the derivations live in projection.ts (pure
 * view-models over the public wire shapes only).
 */

import { distinctionList, esc, formatMicroUsd, keyValueTable } from "./components";
import { advancedDisclosure } from "./disclosure";
import type {
  AgentSessionEventFact,
  AgentSessionFacts,
  ComputerUseDenialFact,
  ComputerUseFacts,
  ComputerUseSessionFact,
  EconomicFacts,
  EdgeFacts,
  MediaFacts,
  MediaJobEventFact,
  PlanningCandidateFact,
  PlanningDecisionFact,
  SubstrateRejectionFact,
  SubstrateSelectionFact,
  TrainingCheckpointFact,
  TrainingFacts,
} from "./projection";
import { emptyState } from "./states";

// ---------------------------------------------------------------------------
// The expert inspection view (AC1 — the run page's Inspection tab)
// ---------------------------------------------------------------------------

function dashOrNull(value: string | null): string {
  return value === null ? "—" : esc(value);
}

function microOrNull(value: string | null): string {
  return value === null ? "—" : esc(formatMicroUsd(value));
}

/** The task-profile row of the inspection view (explanation level). */
function taskProfileRows(decision: PlanningDecisionFact): readonly (readonly [string, string])[] {
  return [
    ["planner version", dashOrNull(decision.plannerVersion)],
    ["task risk level", dashOrNull(decision.riskLevel)],
    ["quality target", decision.qualityTarget === null ? "—" : String(decision.qualityTarget)],
    ["declared cost ceiling", microOrNull(decision.maxCostMicroUsd)],
    [
      "declared latency ceiling",
      decision.maxLatencyMs === null ? "—" : `${decision.maxLatencyMs} ms`,
    ],
    [
      "semantic reasoning required",
      decision.requiresSemanticReasoning === null
        ? "—"
        : decision.requiresSemanticReasoning
          ? "yes"
          : "no",
    ],
  ];
}

/** The effective-policy admission capture (the policy boundary, AC1). */
function policyInputsSection(decision: PlanningDecisionFact): string {
  return `<h3>Effective policy at admission</h3>
<p class="muted">Policy precedes dispatch — this is the platform's own capture of the effective-policy decision that admitted the run (the dashboard never resolves policy).</p>
${keyValueTable([
  ["admission outcome", dashOrNull(decision.policyOutcome)],
  ["policy set", dashOrNull(decision.policySetId)],
  ["policy set version", dashOrNull(decision.policySetVersion)],
])}`;
}

/** The capability resolution capture (AC1). */
function capabilityResolutionSection(decision: PlanningDecisionFact): string {
  const unmet =
    decision.unmetCapabilityIds.length === 0
      ? "—"
      : decision.unmetCapabilityIds.map((id) => esc(id)).join(", ");
  return `<h3>Capability resolution</h3>
${keyValueTable([
  [
    "resolved",
    decision.capabilitySatisfied === null ? "—" : decision.capabilitySatisfied ? "yes" : "no",
  ],
  ["capability catalog revision", dashOrNull(decision.capabilityCatalogRevision)],
  [
    "satisfied capabilities",
    decision.satisfiedCapabilityCount === null ? "—" : String(decision.satisfiedCapabilityCount),
  ],
  ["unmet capabilities", unmet],
])}`;
}

/** The deterministic-first sufficiency decision (AC1). */
function sufficiencySection(decision: PlanningDecisionFact): string {
  return `<h3>Deterministic-first sufficiency</h3>
<p class="muted">The deterministic-first preference is mandatory: a deterministic-sufficient strategy is always preferred over a generative one. This is the platform's recorded sufficiency decision.</p>
${keyValueTable([
  ["sufficiency outcome", dashOrNull(decision.sufficiencyOutcome)],
  [
    "semantic reasoning required",
    decision.semanticReasoningRequired === null
      ? "—"
      : decision.semanticReasoningRequired
        ? "yes"
        : "no",
  ],
  [
    "deterministic quality estimate",
    decision.deterministicQualityEstimate === null
      ? "—"
      : String(decision.deterministicQualityEstimate),
  ],
])}`;
}

function candidateRow(candidate: PlanningCandidateFact): string {
  const admissibility = candidate.admissible
    ? '<span class="glance-kind">Platform fact</span>'
    : '<span class="glance-kind">Explicit absence</span>';
  return `<tr>
  <td class="mono">${esc(candidate.strategyId)}</td>
  <td>${microOrNull(candidate.expectedCostMicroUsd)}</td>
  <td>${candidate.expectedQuality === null ? "—" : String(candidate.expectedQuality)}</td>
  <td>${candidate.expectedLatencyMs === null ? "—" : `${candidate.expectedLatencyMs} ms`}</td>
  <td>${candidate.admissible ? "admissible" : `inadmissible${candidate.inadmissibleReason === null ? "" : ` (${esc(candidate.inadmissibleReason)})`}`}</td>
  <td>${dashOrNull(candidate.routeRationaleCode)}${admissibility}</td>
</tr>`;
}

/** The candidate strategies table (internals — inside disclosure, IR2). */
function candidatesSection(decision: PlanningDecisionFact): string {
  if (decision.candidates.length === 0) {
    return `<h3>Candidate strategies</h3>
${emptyState(
  "No candidate strategies recorded",
  "The planning decision record carries no candidates on this run's public stream.",
)}`;
  }
  const rows = decision.candidates.map(candidateRow).join("\n");
  return `<h3>Candidate strategies</h3>
<p class="muted">Every candidate the planner considered, with its typed estimates and admissibility verdict — admissibility applies the effective policy as hard constraints (a forbidden route makes a candidate inadmissible regardless of its score).</p>
<table class="data">
  <thead><tr><th scope="col">Strategy</th><th scope="col">Expected cost</th><th scope="col">Expected quality</th><th scope="col">Expected latency</th><th scope="col">Admissibility</th><th scope="col">Route rationale</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function substrateCandidateRows(selection: SubstrateSelectionFact): string {
  const rows = selection.admissible
    .map(
      (candidate) => `<tr>
  <td class="mono">${esc(candidate.substrateId)}${candidate.version === null ? "" : ` <span class="muted">@${esc(candidate.version)}</span>`}</td>
  <td>${candidate.isolation === null ? "—" : esc(candidate.isolation)}</td>
  <td>${candidate.latencyClass === null ? "—" : esc(candidate.latencyClass)}</td>
  <td>${
    candidate.cpuMilliCores === null && candidate.memoryMiB === null
      ? "—"
      : `${candidate.cpuMilliCores === null ? "—" : `${candidate.cpuMilliCores}m CPU`} / ${candidate.memoryMiB === null ? "—" : `${candidate.memoryMiB} MiB`}`
  }</td>
  <td>${microOrNull(candidate.estimatedCostMicroUsd)}</td>
</tr>`,
    )
    .join("\n");
  return `<table class="data">
  <thead><tr><th scope="col">Substrate</th><th scope="col">Isolation</th><th scope="col">Latency class</th><th scope="col">Resources</th><th scope="col">Estimated cost</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function substrateRejectionRows(rejections: readonly SubstrateRejectionFact[]): string {
  const rows = rejections
    .map(
      (rejection) => `<tr>
  <td class="mono">${esc(rejection.substrateId)}${rejection.version === null ? "" : ` <span class="muted">@${esc(rejection.version)}</span>`}</td>
  <td>${dashOrNull(rejection.reason)}</td>
  <td>${dashOrNull(rejection.detail)}</td>
</tr>`,
    )
    .join("\n");
  return `<table class="data">
  <thead><tr><th scope="col">Substrate</th><th scope="col">Typed reason</th><th scope="col">Detail</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

/** The compute-substrate selection record (AC1 — the substrate detail). */
function substrateSection(decision: PlanningDecisionFact): string {
  const substrate = decision.substrate;
  if (substrate === null) {
    return `<h3>Compute substrate</h3>
${emptyState(
  "No substrate selection recorded",
  "The planning decision carries no substrate-selection record on this run's public stream — the run may have been planned without one (or the record belongs to a replan not on this stream).",
)}`;
  }
  const selected =
    substrate.outcome === "selected"
      ? keyValueTable([
          ["selected substrate", dashOrNull(substrate.selectedSubstrateId)],
          ["version", dashOrNull(substrate.selectedVersion)],
        ])
      : `<p class="muted">${
          substrate.outcome === "no-substrate-required"
            ? "No substrate was required — the deterministic-first outcome: a deterministic-sufficient strategy needs no substrate at all."
            : "No substrate was admissible — every candidate was inadmissible (fail-closed, honest state; the plan stands on non-substrate routes)."
        }</p>`;
  const admissible =
    substrate.admissible.length === 0
      ? '<p class="muted">No admissible substrate candidates are recorded.</p>'
      : substrateCandidateRows(substrate);
  const inadmissible =
    substrate.inadmissible.length === 0
      ? '<p class="muted">No inadmissible substrate candidates are recorded.</p>'
      : substrateRejectionRows(substrate.inadmissible);
  return `<h3>Compute substrate</h3>
<p class="muted">Substrate selection happens only after policy inputs, capability resolution and deterministic-first sufficiency — the admissible candidates, the typed inadmissible reasons and the selection are the platform's own record. Provider and adapter identities are implementation detail (never the primary mental model).</p>
${selected}
${keyValueTable([
  ["workload class", dashOrNull(substrate.workloadClass)],
  ["selection outcome", dashOrNull(substrate.outcome)],
])}
${advancedDisclosure(
  "Admissible substrate candidates (advanced)",
  `<p class="muted">Neutral resource characteristics as recorded — implementation detail.</p>
${admissible}`,
)}
${advancedDisclosure(
  "Inadmissible substrates with typed reasons (advanced)",
  `<p class="muted">Full honesty: which substrates were inadmissible and why.</p>
${inadmissible}`,
)}
${substrate.rationale === null ? "" : `<p class="muted">Selection rationale: ${esc(substrate.rationale)}</p>`}`;
}

/**
 * The Inspection view (AC1): the expert inspection of HOW this run was
 * planned and executed — the recorded planning decision (selected
 * strategy and rationale first), the effective policy capture, the
 * capability resolution, the sufficiency decision, the candidates, the
 * compute substrate, and the cross-links to the events/lineage/audit
 * advanced views. Deep internals sit inside collapsed disclosures
 * (progressive disclosure, IR2); the DEFAULT user flows are unchanged.
 */
export function inspectionPanel(input: {
  readonly executionId: string;
  readonly environmentId: string | null;
  readonly decision: PlanningDecisionFact | null;
}): string {
  const { decision } = input;
  const id = encodeURIComponent(input.executionId);
  if (decision === null) {
    return `<h2>Inspection</h2>
${emptyState(
  "No planning decision recorded",
  "This run's public event stream carries no planning decision record — the run may predate the planning-evidence surface, or no decision was recorded on the public stream. Nothing is invented here: when a decision is recorded, its facts render live on this tab.",
  "a planning.decision-recorded event on this run's public stream",
)}
<h3>Events, lineage and audit</h3>
<p>The advanced inspection views of every run are always live: <a href="/runs/${id}?tab=activity&amp;view=events">raw events</a> · <a href="/runs/${id}?tab=activity&amp;view=raw">raw payloads</a> · <a href="/runs/${id}?tab=evidence">evidence</a> · <a href="/trust/lineage">lineage (expert)</a> · <a href="/admin/audit">audit (expert)</a></p>
${keyValueTable([["compute environment", input.environmentId === null ? "default" : input.environmentId]])}`;
  }
  const selected =
    decision.selectedStrategyId === null
      ? '<p class="muted">No selected strategy is recorded on this decision.</p>'
      : keyValueTable([
          ["selected strategy", decision.selectedStrategyId],
          ["selection rationale", dashOrNull(decision.selectionRationale)],
        ]);
  return `<h2>Inspection</h2>
<p class="muted">The expert inspection surface: how this run was planned, what policy admitted it, which capabilities resolved, what compute substrate ran it — every fact is the platform's own recorded planning decision, rendered exactly as recorded. Expert depth never changes the default flows: the Result view stays the primary presentation.</p>
<h3>Selected approach</h3>
${selected}
${keyValueTable(taskProfileRows(decision))}
${policyInputsSection(decision)}
${capabilityResolutionSection(decision)}
${sufficiencySection(decision)}
${substrateSection(decision)}
${advancedDisclosure(
  "Candidate strategies and subgraph evidence (advanced)",
  `${candidatesSection(decision)}
<h3>Subgraph evidence</h3>
<p>${
    decision.subgraphEvidenceCount === 0
      ? "No subgraph observations are recorded on this decision."
      : `${decision.subgraphEvidenceCount} subgraph observation${decision.subgraphEvidenceCount === 1 ? "" : "s"} back this decision — the durable detail lives on the raw event payload (<a href="/runs/${id}?tab=activity&amp;view=raw">raw payloads</a>).`
  }</p>`,
)}
${advancedDisclosure(
  "Decision integrity (advanced)",
  `<p class="muted">The platform's own digest of the decision record and its position on the ledger — the integrity anchor, never re-computed here.</p>
${keyValueTable([
  ["decision id", dashOrNull(decision.decisionId)],
  ["ledger sequence", String(decision.sequence)],
  ["recorded at", esc(decision.occurredAt)],
  ["record digest", dashOrNull(decision.recordDigest)],
])}`,
)}
<h3>Events, lineage and audit</h3>
<p>Every advanced view links back to this run: <a href="/runs/${id}?tab=activity&amp;view=events">raw events</a> · <a href="/runs/${id}?tab=activity&amp;view=raw">raw payloads</a> · <a href="/runs/${id}?tab=evidence">evidence</a> · <a href="/trust/lineage">lineage (expert)</a> · <a href="/admin/audit">audit (expert)</a></p>
${keyValueTable([["compute environment", input.environmentId === null ? "default" : input.environmentId]])}`;
}

// ---------------------------------------------------------------------------
// Computer-use (AC2 — the access/risk envelope + action history)
// ---------------------------------------------------------------------------

/** The computer-use access-mode vocabulary (the platform's own modes). */
export const COMPUTER_USE_MODE_LABELS: Readonly<Record<string, string>> = {
  deterministic:
    "Deterministic — no computer-use environment at all: the stage is satisfied structurally (zero browser/desktop dispatches).",
  browser:
    "Browser — isolated browser automation: a declared egress allowlist is enforced platform-side; a host outside it fails closed.",
  desktop:
    "Desktop — isolated desktop and terminal interaction: input devices, filesystem and network grants come from the declared capability envelope, enforced platform-side.",
};

function computerUseSessionRow(session: ComputerUseSessionFact): string {
  return `<tr>
  <td class="mono">${dashOrNull(session.sessionId)}</td>
  <td>${dashOrNull(session.mode)}</td>
  <td>${dashOrNull(session.phase)}</td>
  <td>${
    session.environmentRef === null
      ? "—"
      : `<span class="mono">${esc(session.environmentRef)}</span>`
  }</td>
  <td>${session.inheritedHostStateCount === null ? "—" : String(session.inheritedHostStateCount)}</td>
</tr>`;
}

function computerUseDenialBlock(denial: ComputerUseDenialFact): string {
  return `<li>
  <span class="distinction-state">${denial.code === null ? "Denied" : esc(denial.code)}</span>
  <span class="distinction-fact">Session ${dashOrNull(denial.sessionId)}${
    denial.mode === null ? "" : ` (${esc(denial.mode)} mode)`
  } was denied at admission (${dashOrNull(denial.denialClass)}): ${dashOrNull(denial.reason)} — the platform's own recorded reason, rendered verbatim.</span>
  <span class="glance-kind">Platform fact</span>
</li>`;
}

/**
 * The computer-use section (AC2): the explicit access envelope
 * (deterministic/browser/desktop — the platform's own mode vocabulary),
 * the recorded isolation verdict, the approval story (admission is
 * policy + budget + capability gated; a denied session is the recorded
 * proof) and the risk boundary BEFORE any consequential interaction.
 * Filesystem and network constraint details are the declared capability
 * envelope — enforced platform-side, not on the public wire (stated,
 * never approximated). The dashboard renders NO computer-use action: the
 * only governed mutations remain the create/cancel confirmation flows.
 */
export function computerUseSection(input: {
  readonly executionId: string;
  readonly facts: ComputerUseFacts;
}): string {
  const { facts } = input;
  const id = encodeURIComponent(input.executionId);
  const sessionRows = facts.sessions.map(computerUseSessionRow).join("\n");
  const denials =
    facts.denials.length === 0
      ? '<p class="muted">No computer-use denials are recorded on this run.</p>'
      : `<ul class="distinction-list">${facts.denials.map(computerUseDenialBlock).join("\n  ")}</ul>`;
  const modeStory = Object.entries(COMPUTER_USE_MODE_LABELS)
    .map(
      ([mode, story]) =>
        `<li><span class="distinction-state">${esc(mode)}</span><span class="distinction-fact">${esc(story)}</span><span class="glance-kind">Platform vocabulary</span></li>`,
    )
    .join("\n  ");
  return `<section class="modality-section" aria-labelledby="computer-use-title">
  <h2 id="computer-use-title">Computer use</h2>
  <p class="muted">This run's event stream carries computer-use session evidence. The envelope below is the platform's own recorded admission and isolation facts — access is granted through the governed admission chain (policy, budget, capability), never by this dashboard.</p>
  <h3>Access modes</h3>
  <ul class="distinction-list">
  ${modeStory}
  </ul>
  ${advancedDisclosure(
    "Filesystem and network constraints (advanced)",
    `<p class="muted">Filesystem and network grants come from the declared capability envelope of each session (the desktop envelope, terminal policy and browser profile) — enforced platform-side at environment open. The per-session declared details do not cross the public wire; the recorded isolation verdict below is the public proof: an environment that inherited ANY ambient host state (credentials, cookies, environment, mounts, sockets) fails closed with a non-zero count.</p>`,
  )}
  <h3>Approval and risk before consequential interaction</h3>
  <p>Every computer-use session is admitted through the governed chain — policy first, then budget, then capability; a consequential interaction requires the session to be admitted AND the run to be out of its waiting states. A denied session is recorded here as its own fact (journal-then-fail): the denial code and reason are the platform's own words. This dashboard renders no computer-use action — the run's governed controls remain the <a href="/runs/${id}?action=cancel">cancel confirmation</a> and the platform's own flows.</p>
  <h3>Session history</h3>
  ${
    facts.sessions.length === 0
      ? '<p class="muted">No computer-use session evidence rows are recorded on this run.</p>'
      : `<table class="data">
  <thead><tr><th scope="col">Session</th><th scope="col">Mode</th><th scope="col">Phase</th><th scope="col">Environment</th><th scope="col">Inherited host state</th></tr></thead>
  <tbody>${sessionRows}</tbody>
</table>`
  }
  <h3>Recorded denials</h3>
  ${denials}
  <p class="muted">Every fact above is this run's own event stream — <a href="/runs/${id}?tab=activity&amp;view=raw">the raw payloads</a> carry the full recorded evidence. This section never issues a computer-use action.</p>
</section>`;
}

// ---------------------------------------------------------------------------
// Realtime and messaging (AC3 — Deployment / Session / Execution)
// ---------------------------------------------------------------------------

/** The three-level distinction rows (AC3 — the live structure). */
export function deploymentSessionExecutionRows(): readonly {
  readonly label: string;
  readonly fact: string;
  readonly backed: boolean;
}[] {
  return [
    {
      label: "Deployment",
      fact: "Persistent availability — what stays reachable, on which channel, at which version. The deployment authority's own projection (inventory, health, channels, versions) is NOT public yet: no deployment facts are invented, and an execution status is never rendered in a deployment's place.",
      backed: false,
    },
    {
      label: "Session",
      fact: "One live conversation or turn-based interaction riding a governed execution — the session's evidence (starts, turns, completions, routing class) is recorded on the canonical execution ledger as the platform's own events. Session facts are live per run below.",
      backed: true,
    },
    {
      label: "Execution",
      fact: "The governed work every session rides: the single canonical lifecycle (status, events, verification, cost). A session never has its own status vocabulary — the execution's status IS the state, and every session fact links back to its run.",
      backed: true,
    },
  ];
}

function agentSessionRow(event: AgentSessionEventFact): string {
  const stageLabel =
    event.stage === "session-started"
      ? "Session started"
      : event.stage === "session-completed"
        ? "Session completed"
        : "Session activity";
  const who = event.callerRef ?? event.participantRef;
  const details: string[] = [];
  if (who !== null) {
    details.push(`participant ${esc(who)}`);
  }
  if (event.railCapabilityId !== null) {
    details.push(`rail capability ${esc(event.railCapabilityId)}`);
  }
  if (event.routeClass !== null) {
    details.push(`route class ${esc(event.routeClass)}`);
  }
  if (event.plannerOutcome !== null) {
    details.push(`planner outcome ${esc(event.plannerOutcome)}`);
  }
  if (event.reasonCodes.length > 0) {
    details.push(`reasons ${event.reasonCodes.map((code) => esc(code)).join(", ")}`);
  }
  return `<li>
  <span class="stage">${stageLabel}</span>
  <span class="stage-detail">${details.length === 0 ? "recorded on the ledger" : details.join(" · ")}</span>
</li>`;
}

/**
 * The realtime/messaging section (AC3): the Deployment/Session/Execution
 * distinction with the live session provenance (the agent-session events
 * of THIS run — starts, turns, completions with the platform's own
 * routing facts). Provenance renders contextually; rail identities stay
 * implementation detail (IR4).
 */
export function realtimeMessagingSection(input: {
  readonly executionId: string;
  readonly facts: AgentSessionFacts;
}): string {
  const { facts } = input;
  const id = encodeURIComponent(input.executionId);
  const rows = facts.events.map(agentSessionRow).join("\n");
  return `<section class="modality-section" aria-labelledby="realtime-messaging-title">
  <h2 id="realtime-messaging-title">Realtime and messaging sessions</h2>
  <p class="muted">This run's event stream carries session evidence — a live conversation or turn-based interaction riding this governed execution. The three levels stay distinct:</p>
  ${distinctionList(deploymentSessionExecutionRows())}
  <h3>Session provenance</h3>
  ${
    facts.events.length === 0
      ? '<p class="muted">No session events are recorded on this run.</p>'
      : `<ul class="timeline">
  ${rows}
</ul>`
  }
  <p class="muted">${
    facts.sessionCount === 0
      ? "No sessions are recorded."
      : `${facts.sessionCount} session${facts.sessionCount === 1 ? "" : "s"} recorded on this run's ledger.`
  } The deployment's own availability facts are not public yet — <a href="/deployments">the deployments surface</a> states that absence. Every session fact above belongs to this run: <a href="/runs/${id}">the canonical execution context</a>.</p>
</section>`;
}

// ---------------------------------------------------------------------------
// Media generation (AC4 — asynchronous work, lineage, verification, retry)
// ---------------------------------------------------------------------------

function mediaRow(event: MediaJobEventFact): string {
  const details: string[] = [];
  if (event.generationKind !== null) {
    details.push(`generation kind ${esc(event.generationKind)}`);
  }
  if (event.verificationMode !== null) {
    details.push(`verification ${esc(event.verificationMode)}`);
  }
  if (event.inputArtifactDigest !== null) {
    details.push(`input digest ${esc(event.inputArtifactDigest)}`);
  }
  if (event.preprocessingDigest !== null) {
    details.push(`preprocessing digest ${esc(event.preprocessingDigest)}`);
  }
  if (event.providerStateLabel !== null) {
    details.push(`provider state ${esc(event.providerStateLabel)}`);
  }
  if (event.postprocessingDigest !== null) {
    details.push(`postprocessing digest ${esc(event.postprocessingDigest)}`);
  }
  if (event.outputArtifactDigest !== null) {
    details.push(`output digest ${esc(event.outputArtifactDigest)}`);
  }
  if (event.verifiedByAuthority === true) {
    details.push("verified by the verification authority");
  }
  return `<li>
  <span class="stage">${esc(event.stage)}</span>
  <span class="stage-detail">${details.length === 0 ? "recorded on the ledger" : details.join(" · ")}</span>
</li>`;
}

/**
 * The media-generation section (AC4): asynchronous work as it actually
 * ran — the job lifecycle (submitted, dispatched, observation, artifact,
 * completed) with artifact lineage as DIGEST references (media content
 * never rides the ledger), the verification boundary, and the retry/cancel
 * state through the run's own status. The job's execution moves only
 * through the governed lifecycle commands (verify/pass/fail/cancel).
 */
export function mediaSection(input: {
  readonly executionId: string;
  readonly status: string;
  readonly facts: MediaFacts;
}): string {
  const { facts } = input;
  const id = encodeURIComponent(input.executionId);
  const rows = facts.events.map(mediaRow).join("\n");
  return `<section class="modality-section" aria-labelledby="media-title">
  <h2 id="media-title">Media generation</h2>
  <p class="muted">This run's event stream carries media-generation work evidence — asynchronous work: the job was submitted and dispatched, its artifacts are digest references, and its completion rides the governed lifecycle.</p>
  <h3>Job lifecycle</h3>
  ${
    facts.events.length === 0
      ? '<p class="muted">No media job events are recorded on this run.</p>'
      : `<ul class="timeline">
  ${rows}
</ul>`
  }
  <h3>Artifact lineage</h3>
  <p class="muted">Artifacts are recorded as digest references only — the content lives with the artifact authority: <a href="/assets/artifacts">the artifacts surface</a> and <a href="/runs/${id}?tab=evidence">this run's evidence</a> carry the live lineage. A digest here is the platform's own recorded reference, never re-derived.</p>
  <h3>Verification and retry/cancel state</h3>
  <p>The run's own status (${esc(input.status)}) and its <a href="/runs/${id}?tab=evidence">verification results</a> are the verification state — a settled settlement alone never proves delivery. Retry and cancellation are governed platform operations recorded as their own events; this dashboard issues neither (no action exists here).</p>
</section>`;
}

// ---------------------------------------------------------------------------
// Edge / embodied (AC6 — the local safety boundary)
// ---------------------------------------------------------------------------

/**
 * The edge/embodied section (AC6): the workload-class evidence, the
 * substrate's isolation and latency characteristics, and the boundary
 * sentence — the hard-real-time safety loop stays LOCAL. The current
 * physical command and the local safety state are not public facts
 * (stated); the cloud surface never implies control of the safety loop.
 */
export function edgeSection(input: {
  readonly executionId: string;
  readonly facts: EdgeFacts;
}): string {
  const { facts } = input;
  const id = encodeURIComponent(input.executionId);
  return `<section class="modality-section" aria-labelledby="edge-title">
  <h2 id="edge-title">Edge / embodied work</h2>
  <p class="muted">This run's planning evidence records an edge/embodied workload class.</p>
  ${keyValueTable([
    ["workload class", dashOrNull(facts.workloadClass)],
    ["substrate", dashOrNull(facts.substrateId)],
    ["isolation", dashOrNull(facts.isolation)],
    ["latency class", dashOrNull(facts.latencyClass)],
  ])}
  <h3>The safety boundary</h3>
  <p>Hard-real-time safety authority stays LOCAL to the edge substrate — this cloud surface inspects recorded facts and never owns, implies or issues real-time control of the safety loop. No command, actuation or override exists on this page.</p>
  <h3>What is live vs. honest absence</h3>
  ${distinctionList([
    {
      label: "Authorization",
      fact: "The governed admission chain — the run's effective-policy capture and capability resolution (the Inspection tab) are the recorded authorization evidence for this work.",
      backed: true,
    },
    {
      label: "Last verified state",
      fact: "The run's verification results — the platform's own per-execution checks are the last verified state reachable through the public wire: open the Evidence view.",
      backed: true,
    },
    {
      label: "Current physical command",
      fact: "The substrate's current physical command is a LOCAL runtime fact; it does not cross the public wire and is never approximated here. The recorded events (the Inspection and Activity views) are the inspectable history.",
      backed: false,
    },
    {
      label: "Local safety state",
      fact: "The safety loop's own state (sensors, interlocks, actuator guards) is owned locally by the edge substrate — publishing it here would imply cloud ownership of the safety loop, so this surface never claims it.",
      backed: false,
    },
  ])}
  <p class="muted">Every fact above traces to this run: <a href="/runs/${id}">the canonical execution context</a>.</p>
</section>`;
}

// ---------------------------------------------------------------------------
// Training / accelerators (AC7 — resource selection, checkpoints)
// ---------------------------------------------------------------------------

function trainingCheckpointRow(checkpoint: TrainingCheckpointFact): string {
  return `<tr>
  <td>${checkpoint.checkpointSequence === null ? "—" : String(checkpoint.checkpointSequence)}</td>
  <td>${checkpoint.stepPosition === null ? "—" : String(checkpoint.stepPosition)}</td>
  <td class="mono">${dashOrNull(checkpoint.metricsDigest)}</td>
  <td>${esc(checkpoint.occurredAt)}</td>
</tr>`;
}

/**
 * The training/accelerator section (AC7): the workload's own recorded
 * facts (workload id, kind, attempt, outcome, steps, usage) with the
 * resource selection and checkpoints as ADVANCED detail — preserving the
 * compute/training/evaluation/release distinctions (the four-state list
 * renders on the long-running section). Accelerator identities are
 * implementation detail.
 */
export function trainingDetailSection(input: {
  readonly executionId: string;
  readonly facts: TrainingFacts;
}): string {
  const { facts } = input;
  const id = encodeURIComponent(input.executionId);
  const checkpointRows = facts.checkpoints.map(trainingCheckpointRow).join("\n");
  return `<section class="modality-section" aria-labelledby="training-title">
  <h2 id="training-title">Training / accelerator work</h2>
  <p class="muted">This run's event stream carries training workload evidence — a governed long-running workload executing in a compute/accelerator environment through the sandbox admission chain.</p>
  ${keyValueTable([
    ["workload", dashOrNull(facts.workloadId)],
    ["workload kind", dashOrNull(facts.workloadKind)],
    ["attempt", facts.attempt === null ? "—" : String(facts.attempt)],
    ["outcome", dashOrNull(facts.outcomeClass)],
    ["steps completed", facts.stepsCompleted === null ? "—" : String(facts.stepsCompleted)],
    ["settled usage", microOrNull(facts.usageMicroUsd)],
  ])}
  ${
    facts.denied
      ? `<div class="state state-blocked" role="status">
  <p><strong>Admission denied (${dashOrNull(facts.denialCode)}).</strong> ${dashOrNull(facts.denialReason)} — the platform's own recorded reason, rendered verbatim.</p>
</div>`
      : ""
  }
  ${advancedDisclosure(
    "Resource selection and checkpoints (advanced)",
    `<p class="muted">Resource characteristics and checkpoints are advanced details — the resource profile is the substrate-selection record (the Inspection tab); the checkpoints below are the platform's own recorded training checkpoints (metrics digests, never re-computed).</p>
${
  facts.checkpoints.length === 0
    ? '<p class="muted">No training checkpoints are recorded on this run.</p>'
    : `<table class="data">
  <thead><tr><th scope="col">Checkpoint</th><th scope="col">Step position</th><th scope="col">Metrics digest</th><th scope="col">Recorded</th></tr></thead>
  <tbody>${checkpointRows}</tbody>
</table>`
}
${facts.outputArtifactDigest === null ? "" : `<p class="muted">Output artifact digest: <span class="mono">${esc(facts.outputArtifactDigest)}</span> — <a href="/assets/artifacts">the artifacts surface</a> carries the live artifact facts.</p>`}`,
  )}
  <p class="muted">Compute complete, training complete, evaluation passed and release approved remain four DISTINCT states (the long-running section's distinction list) — none is implied by another, and this surface never claims release. Every fact traces to <a href="/runs/${id}">the canonical execution context</a>.</p>
</section>`;
}

// ---------------------------------------------------------------------------
// Economic actions (AC8 — the four-axis separation)
// ---------------------------------------------------------------------------

/** The four-axis distinction rows (AC8 — intent → authorization → settlement → verification). */
export function economicAxisRows(): readonly {
  readonly label: string;
  readonly fact: string;
  readonly backed: boolean;
}[] {
  return [
    {
      label: "Bounded intent",
      fact: "The proposed economic action — bounded purpose, recipient, amount and expiration, recorded with the proposing actor as provenance (never an approver). The bounded envelope is the economics authority's own record; the public execution wire carries the provenance timeline (below), and the envelope's own public projection does not exist yet.",
      backed: false,
    },
    {
      label: "Authorization",
      fact: "A separate governed decision: policy, capability and budget admit the intent BEFORE any money moves — the authorization itself never crosses this wire (bounded, tokenized references only). The run's timeline below records that an authorization event occurred, as the platform's own ledger fact.",
      backed: true,
    },
    {
      label: "Settlement",
      fact: "The external money movement, observed and correlated as its own evidence — never a Zeck money-movement truth (the budgets authority owns that). A settlement observation alone never proves delivery.",
      backed: true,
    },
    {
      label: "Resource / outcome verification",
      fact: "Independent verification that the resource was delivered or the outcome holds — the verification authority's own per-execution checks are the live public record: this run's Evidence view is where delivery claims are proven, separately from payment.",
      backed: true,
    },
  ];
}

/**
 * The economic-action section (AC8): the four-axis separation (economic
 * intent, authorization, settlement and verification are SEPARATE — a
 * settlement alone never proves delivery) with the live execution-bound
 * provenance timeline. The bounded envelope's own details (purpose,
 * recipient, amount, expiration) are the economics authority's records
 * and do not cross the public execution wire — stated, never approximated.
 */
export function economicSection(input: {
  readonly executionId: string;
  readonly facts: EconomicFacts;
}): string {
  const { facts } = input;
  const id = encodeURIComponent(input.executionId);
  const rows = facts.timeline
    .map(
      (row) => `<tr>
  <td>${esc(row.phase)}</td>
  <td class="mono">${dashOrNull(row.economicActionId)}</td>
  <td class="mono">${esc(row.occurredAt)}</td>
  <td>${String(row.sequence)}</td>
</tr>`,
    )
    .join("\n");
  return `<section class="modality-section" aria-labelledby="economic-title">
  <h2 id="economic-title">Economic actions</h2>
  <p class="muted">This run's event stream carries economic-action provenance — governed economic intent bound to this execution. The four axes stay separate:</p>
  ${distinctionList(economicAxisRows())}
  <h3>Provenance timeline</h3>
  ${
    facts.timeline.length === 0
      ? '<p class="muted">No economic-action events are recorded on this run.</p>'
      : `<table class="data">
  <thead><tr><th scope="col">Phase</th><th scope="col">Economic action</th><th scope="col">Occurred</th><th scope="col">#</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
  }
  <p class="muted">${
    facts.actionIds.length === 0
      ? "No economic action ids are recorded."
      : `${facts.actionIds.length} economic action${facts.actionIds.length === 1 ? "" : "s"} on this run's ledger (ids as recorded).`
  } The bounded envelope, the authorization result and the settlement correlation are the economics authority's own records — they do not cross the public execution wire, and this surface never guesses them. Independent outcome verification is live: <a href="/runs/${id}?tab=evidence">this run's evidence</a>. This dashboard renders no economic action (no client-side payment authorization exists anywhere).</p>
</section>`;
}

// ---------------------------------------------------------------------------
// The modality composition (AC9 — every advanced view links back)
// ---------------------------------------------------------------------------

/**
 * The contextual modality sections of a run (AC9): each renders ONLY when
 * the run's public event stream carries that modality's facts, and each
 * links back to the canonical run context. One vocabulary throughout —
 * the modality sections never create a second status language (the run's
 * status IS the state; the recorded events ARE the evidence).
 */
export function modalitySections(input: {
  readonly executionId: string;
  readonly status: string;
  readonly environmentId: string | null;
  readonly computerUse: ComputerUseFacts;
  readonly agentSessions: AgentSessionFacts;
  readonly media: MediaFacts;
  readonly edge: EdgeFacts;
  readonly training: TrainingFacts;
  readonly economic: EconomicFacts;
}): string {
  const sections: string[] = [];
  if (input.computerUse.present) {
    sections.push(computerUseSection({ executionId: input.executionId, facts: input.computerUse }));
  }
  if (input.agentSessions.present) {
    sections.push(
      realtimeMessagingSection({ executionId: input.executionId, facts: input.agentSessions }),
    );
  }
  if (input.media.present) {
    sections.push(
      mediaSection({ executionId: input.executionId, status: input.status, facts: input.media }),
    );
  }
  if (input.edge.present) {
    sections.push(edgeSection({ executionId: input.executionId, facts: input.edge }));
  }
  if (input.training.present) {
    sections.push(trainingDetailSection({ executionId: input.executionId, facts: input.training }));
  }
  if (input.economic.present) {
    sections.push(economicSection({ executionId: input.executionId, facts: input.economic }));
  }
  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// The deployments surface extension (AC3 — the operational distinction)
// ---------------------------------------------------------------------------

/**
 * The deployments surface's availability distinction (AC3): the
 * Deployment/Session/Execution levels with the live session evidence
 * from the browser's recents scope — every session fact links to its
 * run; the deployment authority's own absence stays explicit.
 */
export function deploymentSessionExecutionSection(input: {
  readonly sessionRuns: readonly {
    readonly executionId: string;
    readonly sessionCount: number;
    readonly lastActivity: string | null;
  }[];
}): string {
  const rows = input.sessionRuns
    .map(
      (run) => `<tr>
  <td><a class="mono" href="/runs/${encodeURIComponent(run.executionId)}">${esc(run.executionId)}</a></td>
  <td>${run.sessionCount}</td>
  <td>${run.lastActivity === null ? "—" : esc(run.lastActivity)}</td>
</tr>`,
    )
    .join("\n");
  return `<h2>Availability and the governed work behind it</h2>
<p>Deployments are persistent availability; sessions are the live conversations; executions are the governed work every session rides — three levels, never merged:</p>
${distinctionList(deploymentSessionExecutionRows())}
<h3>Live session evidence (this browser's runs)</h3>
${
  input.sessionRuns.length === 0
    ? emptyState(
        "No session evidence in this browser's scope",
        "The public API exposes no execution listing: session evidence is live per run — open a run by id, or track runs from executions opened in this browser.",
      )
    : `<table class="data">
  <thead><tr><th scope="col">Execution</th><th scope="col">Sessions</th><th scope="col">Last activity</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
}
<p class="muted">A session's routing facts, turns and completions are on each run's page (the Realtime and messaging sessions section). The deployment authority's own projection (inventory, health, channels, versions) is not public yet — nothing here substitutes for it, and an execution status never renders as availability.</p>`;
}
