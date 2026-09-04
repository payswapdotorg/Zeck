/**
 * Zeck dashboard components — typed functions returning escaped HTML
 * (WORK-033, re-homed on the WORK-035 foundation).
 *
 * The zero-dependency, server-rendered component system. Every component
 * is a PURE function over public wire shapes and derived view-model
 * values: no state, no network, no caching. All interpolated values pass
 * through `esc` (the one escape boundary). Status is always communicated
 * by symbol + text, never color alone. Money is rendered from integer
 * micro-USD strings with BigInt arithmetic only.
 *
 * The shared state primitives (loading/empty/error/denied/confirmation),
 * the attention vocabulary and the disclosure/sheet primitives live in
 * their own WORK-035 foundation modules (states.ts, attention.ts,
 * disclosure.ts); this file owns the EXECUTION-SURFACE components.
 */

import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../sdk";
import { advancedDisclosure, sheetDialog } from "./disclosure";
import {
  classifyFailure,
  declaredBudgetMicroUsd,
  deriveConfidenceChip,
  derivePolicyAxis,
  deriveQualityAxis,
  deriveRecoverability,
  eventStageLabel,
  executionTitle,
  type GlanceFact,
  isSecretShapedKey,
  redactSecretShaped,
  safeTaskPairs,
  statusLabel,
  statusSymbol,
  type TrainingStateRow,
  trainingStateRows,
  type WorkloadFacts,
  type WorkloadRecoveryKind,
  waitQuestion,
} from "./projection";
import { emptyState } from "./states";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** HTML-escape every interpolated value (no injection through data). */
export function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Integer micro-USD string → display dollars, integer/BigInt arithmetic
 * ONLY (the platform money discipline; never floats). Sub-cent precision
 * is preserved honestly rather than rounded away.
 */
export function formatMicroUsd(microUsd: string): string {
  let value: bigint;
  try {
    value = BigInt(microUsd);
  } catch {
    return esc(microUsd);
  }
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const dollars = abs / 1_000_000n;
  const remainder = abs % 1_000_000n;
  const fraction = remainder.toString().padStart(6, "0");
  const centPrecision = remainder % 10_000n === 0n;
  const fractionText = centPrecision ? fraction.slice(0, 2) : fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}$${dollars.toString()}.${fractionText}`;
}

/** Milliseconds → human duration ("3m 42s"). */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/** Status badge: symbol + text (never color alone). */
export function statusBadge(status: string): string {
  return `<span class="badge status-${esc(status)}"><span class="symbol" aria-hidden="true">${esc(
    statusSymbol(status),
  )}</span>${esc(statusLabel(status))}</span>`;
}

/** A two-column key/value table (th scope="row"). */
export function keyValueTable(pairs: readonly (readonly [string, string])[]): string {
  if (pairs.length === 0) {
    return '<p class="muted">No fields recorded.</p>';
  }
  const rows = pairs
    .map(([key, value]) => `<tr><th scope="row">${esc(key)}</th><td>${esc(value)}</td></tr>`)
    .join("");
  return `<table class="kv"><tbody>${rows}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// Execution header (UX v2 §9: title + status on one line — the title and
// badge live in the page-head treatment; this component renders the facts)
// ---------------------------------------------------------------------------

export interface ExecutionHeaderView {
  readonly execution: Execution;
  readonly durationMs: number;
  readonly costMicroUsd: string | null;
  readonly verificationChip: string | null;
  /** WORK-036 AC5: the four-axis trust state from platform facts. */
  readonly trustAxes: readonly TrustAxisView[];
  readonly now?: number;
}

/** The compact per-axis view model (kind, label — never merged into one score). */
export interface TrustAxisView {
  readonly kind: string;
  readonly label: string;
}

/**
 * The execution facts header: duration, cost, checks, created and the id,
 * rendered below the page-head (which owns the single h1 — the execution
 * title + status badge line), plus the compact four-axis trust strip
 * (WORK-036 AC5: status, duration, cost and trust state using platform
 * facts — each axis a SEPARATE fact, never a single score).
 */
export function executionHeader(view: ExecutionHeaderView): string {
  const { execution } = view;
  const facts: string[] = [
    `<span class="fact"><span class="fact-label">Duration</span><span>${esc(
      formatDuration(view.durationMs),
    )}</span></span>`,
  ];
  if (view.costMicroUsd !== null) {
    facts.push(
      `<span class="fact"><span class="fact-label">Cost</span><span>${esc(
        formatMicroUsd(view.costMicroUsd),
      )}</span></span>`,
    );
  }
  if (view.verificationChip !== null) {
    facts.push(
      `<span class="fact"><span class="fact-label">Checks</span><span>${esc(
        view.verificationChip,
      )}</span></span>`,
    );
  }
  facts.push(
    `<span class="fact"><span class="fact-label">Created</span><span class="mono">${esc(
      execution.createdAt,
    )}</span></span>`,
  );
  const axes = view.trustAxes
    .map(
      (axis) =>
        `<li><span class="axis-kind">${esc(axis.kind)}</span><span class="axis-fact">${esc(
          axis.label,
        )}</span></li>`,
    )
    .join("\n    ");
  return `<header class="execution-header">
  <div class="facts">${facts.join("\n    ")}</div>
  <ul class="trust-strip" aria-label="Trust state — four separate facts">
    ${axes}
  </ul>
  <p class="muted mono">${esc(execution.id)}</p>
</header>`;
}

// ---------------------------------------------------------------------------
// Verification summary (UX §6.3) — never invents confidence
// ---------------------------------------------------------------------------

function checkLine(check: VerificationResult): string {
  const symbol = check.status === "PASS" ? "✓" : check.status === "FAIL" ? "✕" : "–";
  return `<li><span aria-hidden="true">${symbol}</span> ${esc(check.criterionId)} <span class="muted">(${esc(
    check.status,
  )})</span></li>`;
}

/**
 * The verification surface. `compact` renders the result-tab strip; the
 * full form renders the evidence-tab table. With ZERO results it renders
 * the honest "No verification results recorded" state — and NEVER a
 * confidence verdict (the quality axis owns that honesty).
 *
 * WORK-038 AC2: the full table's evidence refs render through the
 * caller-supplied `renderEvidenceRef` when provided — the trust module
 * links each recorded reference to the artifact view when the platform
 * exposes an object with that id, and shows the reference verbatim
 * otherwise (never a fabricated target).
 */
export function verificationSummary(
  verification: readonly VerificationResult[],
  options: {
    readonly compact?: boolean;
    readonly executionId?: string;
    /** WORK-038: renders one evidence reference (link or verbatim). */
    readonly renderEvidenceRef?: (reference: string) => string;
  } = {},
): string {
  if (verification.length === 0) {
    return emptyState(
      "No verification results recorded",
      "The platform has not recorded verification results for this execution, so no confidence claim is shown.",
      deriveQualityAxis(verification).source,
    );
  }
  const passed = verification.filter((check) => check.status === "PASS").length;
  const derivedChip = deriveConfidenceChip(verification);
  const evidenceLink =
    options.executionId === undefined
      ? ""
      : `<p><a href="/runs/${encodeURIComponent(options.executionId)}?tab=evidence">View evidence</a></p>`;
  if (options.compact === true) {
    return `<div class="verification-strip">
  <p><strong>${passed} of ${verification.length} checks passed</strong>${
    derivedChip === null ? "" : ` <span class="chip chip-derived">${esc(derivedChip)}</span>`
  }</p>
  <ul class="timeline">${verification.map(checkLine).join("\n  ")}</ul>
  ${evidenceLink}
</div>`;
  }
  const renderRef = options.renderEvidenceRef ?? ((reference: string) => esc(reference));
  const rows = verification
    .map(
      (check) => `<tr>
    <td class="mono">${esc(check.criterionId)}</td>
    <td>${esc(check.strategy)}</td>
    <td>${esc(check.status)}</td>
    <td>${check.confidence === null ? "—" : esc(check.confidence)}</td>
    <td class="mono">${esc(check.evaluator.kind)}:${esc(check.evaluator.id)} <span class="muted">v${esc(
      check.evaluator.version,
    )}</span></td>
    <td class="mono">${check.evidenceRefs.map((ref) => renderRef(ref)).join(", ")}</td>
    <td class="mono">${esc(check.recordedAt)}</td>
  </tr>`,
    )
    .join("");
  return `<div class="verification-table" id="verification-results">
  <p><strong>${passed} of ${verification.length} checks passed</strong>${
    derivedChip === null ? "" : ` <span class="chip chip-derived">${esc(derivedChip)}</span>`
  }</p>
  <table class="data">
    <thead><tr>
      <th scope="col">Criterion</th><th scope="col">Strategy</th><th scope="col">Status</th>
      <th scope="col">Confidence</th><th scope="col">Evaluator</th><th scope="col">Evidence refs</th>
      <th scope="col">Recorded</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

// ---------------------------------------------------------------------------
// Progress timeline (UX §7) — chronological, never a graph by default
// ---------------------------------------------------------------------------

function payloadProgress(event: ExecutionEvent): string | null {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ["progress", "progressPercent", "percent"]) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) {
      return `${value}%`;
    }
  }
  return null;
}

/**
 * The chronological `<ol>` of execution events with friendly stage labels.
 * Unknown event types render verbatim. A percentage appears ONLY when the
 * platform payload itself carries one — never fabricated.
 */
export function progressTimeline(events: readonly ExecutionEvent[]): string {
  const ordered = [...events].sort(
    (a, b) => a.sequence - b.sequence || a.occurredAt.localeCompare(b.occurredAt),
  );
  if (ordered.length === 0) {
    return emptyState(
      "No activity recorded",
      "No events are recorded for this execution yet; the public event stream is read live.",
    );
  }
  const items = ordered
    .map((event) => {
      const progress = payloadProgress(event);
      const known = eventStageLabel(event.type) !== event.type;
      const detail = progress === null ? "" : `<span class="stage-detail">${esc(progress)}</span>`;
      return `<li><time>${esc(event.occurredAt)}</time><span class="stage">${esc(
        eventStageLabel(event.type),
      )}${known ? "" : ' <span class="muted">(unknown event type)</span>'}</span>${detail}</li>`;
    })
    .join("\n  ");
  return `<ol class="timeline">${items}</ol>`;
}

// ---------------------------------------------------------------------------
// Why panel (UX §6.4) — "How Zeck did it", platform facts only
// ---------------------------------------------------------------------------

export interface WhyPanelView {
  readonly execution: Execution;
  readonly result: ExecutionResult;
  readonly events: readonly ExecutionEvent[];
}

/**
 * The persistent `<details>` disclosure above the tabs — "How Zeck did it"
 * (WORK-036 AC7), structured to answer the v2 §11 questions in order:
 * What did Zeck understand? What capabilities were required? What
 * approach did Zeck choose? Why was that approach permitted? Why was
 * this route selected? What did Zeck deliberately avoid? How was the
 * result verified? Every answer is a platform fact or an honest
 * not-exposed note — infrastructure (route/provider/compute) stays
 * inside the advanced disclosure, never the primary mental model.
 */
export function whyPanel(view: WhyPanelView): string {
  const { execution, result, events } = view;
  const taskPairs = safeTaskPairs(execution.task);
  const understood =
    taskPairs.length === 0
      ? '<p class="muted">The public task record carries no fields for this execution.</p>'
      : keyValueTable(taskPairs);
  const planningEvents = events.filter(
    (event) =>
      event.type === "execution.plan" ||
      event.type === "execution.replan" ||
      event.type === "planning.decision-recorded",
  );
  const planSteps =
    planningEvents.length === 0
      ? '<p class="muted">No planning events are recorded; the full plan graph is not carried by this projection.</p>'
      : `<ol>${planningEvents
          .map((event) => `<li>${esc(eventStageLabel(event.type))}</li>`)
          .join("")}</ol>`;
  const strategy =
    result.route === null || result.route.strategyClass === null
      ? '<p class="muted">No strategy class is recorded yet.</p>'
      : `<p>${esc(result.route.strategyClass)}</p>`;
  const route =
    result.route === null
      ? '<p class="muted">No route is recorded yet.</p>'
      : keyValueTable([
          ["provider", result.route.provider ?? "(deterministic)"],
          ["model", result.route.model ?? "—"],
          ["strategy class", result.route.strategyClass ?? "—"],
          ["model calls", String(result.route.modelCalls)],
        ]);
  const policyAxis = derivePolicyAxis(execution, events);
  const permitted = `<p><strong>${esc(policyAxis.label)}</strong> — ${esc(policyAxis.detail)}</p>`;
  const constraints = execution.constraints as Record<string, unknown> | null;
  const constraintKeys =
    constraints === null
      ? []
      : Object.keys(constraints).filter((key) => constraints[key] !== undefined);
  const whyRoute =
    constraintKeys.length === 0
      ? "<p>The route rationale detail is not exposed; the request carried no explicit constraints.</p>"
      : `<p>Selected within the requested ${constraintKeys
          .map((key) => esc(key))
          .join(
            ", ",
          )} target(s); the detailed route rationale is not exposed by this projection.</p>`;
  const cost =
    result.cost === null
      ? '<p class="muted">No settled cost facts yet.</p>'
      : `<p>${esc(formatMicroUsd(result.cost.totalMicroUsd))} <span class="muted">(${esc(
          result.cost.totalMicroUsd,
        )} micro-USD)</span></p>`;
  const verificationAnswer =
    result.verification.length === 0
      ? '<p class="muted">No verification results are recorded yet — no confidence claim is shown.</p>'
      : `<p>${esc(deriveQualityAxis(result.verification).label)} — each check is a platform verification result; the full table is on the Evidence view.</p>
<p><a href="/runs/${encodeURIComponent(execution.id)}?tab=evidence">View the evidence</a></p>`;
  return `<details class="why-panel">
  <summary>How Zeck did it</summary>
  <div class="why-body">
    <h3>Understood task — what did Zeck understand?</h3>
    ${understood}
    <h3>What capabilities were required?</h3>
    <p class="muted">capability detail is not exposed by this projection</p>
    <h3>Plan — what approach did Zeck choose?</h3>
    ${planSteps}
    <p class="muted">Strategy class: ${strategy}</p>
    <h3>Why was that approach permitted?</h3>
    ${permitted}
    <h3>Route — why was this route selected?</h3>
    <p class="muted">Provider and model are secondary details of the governed route.</p>
    ${advancedDisclosure("Route detail (advanced)", route)}
    ${sheetDialog({
      id: "route-detail-sheet",
      title: "Route detail — focused panel",
      bodyHtml: `<p class="muted">The same advanced facts as the inline disclosure, presented in the focused panel (the tablet/mobile inspection surface). Focus returns to the opener when the panel closes.</p>
${route}`,
      closeLabel: "Close panel",
    })}
    <p><button type="button" data-sheet-open="route-detail-sheet">Open route detail in a focused panel</button></p>
    <h3>What did Zeck deliberately avoid?</h3>
    <p>The request selected no provider, model, rail, connection or agent (the create contract forbids provider selection — API-001). Deliberately-avoided alternatives are part of the plan rationale, which this projection does not carry.</p>
    ${whyRoute}
    <h3>Compute</h3>
    <p>${execution.environmentId === null ? "default" : esc(execution.environmentId)}</p>
    <h3>Cost</h3>
    ${cost}
    <h3>How was the result verified?</h3>
    ${verificationAnswer}
  </div>
</details>`;
}

// ---------------------------------------------------------------------------
// Result surface (UX §6.3)
// ---------------------------------------------------------------------------

function payloadMessage(event: ExecutionEvent | undefined): string | null {
  if (event === undefined) {
    return null;
  }
  const payload = redactSecretShaped(event.payload) as Record<string, unknown>;
  for (const key of ["message", "error", "reason", "detail"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function lastEventOfType(
  events: readonly ExecutionEvent[],
  predicate: (type: string) => boolean,
): ExecutionEvent | undefined {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (event !== undefined && predicate(event.type)) {
      return event;
    }
  }
  return undefined;
}

function waitingSurface(execution: Execution, events: readonly ExecutionEvent[]): string {
  const waitEvent = lastEventOfType(events, (type) => type.startsWith("execution.wait-"));
  const knownPairs: [string, string][] = waitEvent === undefined ? [] : [];
  if (waitEvent !== undefined) {
    const payload = redactSecretShaped(waitEvent.payload) as Record<string, unknown>;
    for (const [key, value] of Object.entries(payload)) {
      knownPairs.push([key, typeof value === "string" ? value : (JSON.stringify(value) ?? "—")]);
    }
  }
  const known =
    knownPairs.length === 0
      ? '<p class="muted">No detail is recorded on the public wait event.</p>'
      : keyValueTable(knownPairs);
  const question = waitQuestion(events);
  const questionBlock =
    question === null ? "" : `<p class="wait-question"><strong>${esc(question)}</strong></p>`;
  return `<section class="waiting-surface card">
  <h3>Decision needed</h3>
  ${questionBlock}
  <p>Zeck is waiting: this is a normal governed execution state, not an error.</p>
  ${known}
  <div class="decision-consequences">
    <p><strong>What deciding means:</strong> your answer lets the governed work continue. Resolve it through your application's governed path — the public API does not expose a resolve command for this wait.</p>
    <p><strong>What cancelling means:</strong> the execution moves to the terminal state Cancelled; work already performed stays recorded and inspectable. Cancellation goes through its own consequence preview.</p>
  </div>
  <p class="muted">When the wait is resolved, the execution resumes from the recorded state — the status on this page is a live platform fact, refreshed from the governed API.</p>
  <div class="actions">
    <a class="button-link" href="/runs/${encodeURIComponent(
      execution.id,
    )}?action=cancel">Cancel this execution…</a>
    <a href="/runs">Return to your work</a>
  </div>
</section>`;
}

function failedSurface(
  execution: Execution,
  result: ExecutionResult,
  events: readonly ExecutionEvent[],
): string {
  const classification = classifyFailure(execution, result, events);
  const facts = deriveRecoverability(events);
  const failEvent = lastEventOfType(events, (type) => type.includes("fail"));
  const stage = failEvent === undefined ? null : eventStageLabel(failEvent.type);
  const message = payloadMessage(failEvent);
  const title = executionTitle(execution.task, execution.id);
  const retryHref = `/build/execution?outcome=${encodeURIComponent(
    title,
  )}&applicationId=${encodeURIComponent(execution.applicationId)}`;
  const reasonBlock =
    classification.recordedReason === null
      ? '<p class="muted">No failure-bearing event is recorded in the public event stream — the terminal state alone is the fact.</p>'
      : `<p>Last recorded failure event: <strong>${esc(stage ?? "Failed")}</strong>${
          message === null ? "" : ` — ${esc(message)}`
        }</p>`;
  // AC10: the recoverability block — a platform-recorded fact when one
  // exists, the explicit limitation otherwise. NEVER prose that asks the
  // user to classify the recorded reason by what it "describes".
  const recoverabilityBlock =
    facts.retryable === true
      ? `<p class="recovery-fact"><strong>Recoverability (platform-recorded):</strong> the platform recorded this failure as <strong>retryable</strong>${
          facts.failureClass === null ? "" : ` — failure class ${esc(facts.failureClass)}`
        }${
          facts.source === null ? "" : ` (on the ${esc(facts.source)} event)`
        }. A new attempt is the governed path — a fresh run with its own idempotency key.</p>`
      : facts.retryable === false
        ? `<p class="recovery-fact"><strong>Recoverability (platform-recorded):</strong> the platform recorded this failure as <strong>not retryable</strong>${
            facts.failureClass === null ? "" : ` — failure class ${esc(facts.failureClass)}`
          }${
            facts.source === null ? "" : ` (on the ${esc(facts.source)} event)`
          } — repeating the identical request is expected to fail the same way. Refine the request before starting a new attempt.</p>`
        : facts.failureClass !== null
          ? `<p class="recovery-fact"><strong>Recoverability:</strong> the platform recorded failure class <strong>${esc(
              facts.failureClass,
            )}</strong>${
              facts.source === null ? "" : ` (on the ${esc(facts.source)} event)`
            }, and the public event stream carries no retryable classification for this failure — the dashboard does not infer one from the recorded class.</p>`
          : `<p class="recovery-fact"><strong>Recoverability:</strong> the public contract exposes no authoritative recoverability or provider/infrastructure classification for this execution — only the terminal status and the recorded events are the facts, and the dashboard does not classify the recorded reason. If the platform records a typed retryable or failure-class fact, it is surfaced here verbatim.</p>`;
  const retryPrimary = facts.retryable === true;
  return `<section class="failure-surface card">
  <h3>Zeck could not complete this execution</h3>
  <p class="failure-dimension">This is an <strong>execution failure</strong> — the run itself did not complete. That is a different fact from a quality failure (checks failing on completed work); the two are never merged.</p>
  ${reasonBlock}
  ${recoverabilityBlock}
  <p class="failure-distinction">This is distinct from a quality failure, where the failed verification checks are the platform's authoritative facts — there the run completed, and the recoverability question does not arise.</p>
  <div class="actions">
    <a href="/runs/${encodeURIComponent(execution.id)}?tab=activity">View activity</a>
    <a href="/runs/${encodeURIComponent(execution.id)}?tab=evidence">View evidence</a>
    <a${retryPrimary ? ' class="button-link"' : ""} href="${esc(retryHref)}">Start a new attempt</a>
  </div>
</section>`;
}

/**
 * The quality-failure notice (WORK-036 AC10): a COMPLETED execution whose
 * verification recorded FAIL checks. The distinction is a platform fact —
 * the execution succeeded; the checks did not pass — and is stated as its
 * own dimension, never merged with the execution-failure surface. The
 * failed checks ARE the platform's authoritative facts for this result;
 * no recoverability/provider classification applies to them.
 */
function qualityFailureNotice(execution: Execution, failedChecks: number): string {
  const id = encodeURIComponent(execution.id);
  return `<section class="quality-failure-surface card">
  <h3>The work completed, but ${failedChecks} verification check${
    failedChecks === 1 ? "" : "s"
  } failed</h3>
  <p class="failure-dimension">This is a <strong>quality failure</strong> — a different fact from an execution failure. The execution ran to completion; the outcome did not pass its recorded checks, so treat the result as unverified until the evidence is reviewed.</p>
  <p class="failure-distinction">The failed checks are the platform's authoritative facts here: the recoverability question that an execution failure carries does not arise — there is no provider or infrastructure failure to recover from, only evidence to review.</p>
  <div class="actions">
    <a class="button-link" href="/runs/${id}?tab=evidence">Review the evidence</a>
    <a href="/runs/${id}?tab=activity">View activity</a>
  </div>
</section>`;
}

function nextActions(execution: Execution, result: ExecutionResult): string {
  const id = encodeURIComponent(execution.id);
  if (execution.status === "COMPLETED") {
    return `<div class="actions">
  <a href="/runs/${id}?tab=evidence">View evidence</a>${
    result.outputArtifacts.length === 0 ? "" : `\n  <a href="/assets/artifacts">View artifacts</a>`
  }
</div>`;
  }
  if (execution.status === "CANCELLED" || execution.status === "EXPIRED") {
    const title = executionTitle(execution.task, execution.id);
    const retryHref = `/build/execution?outcome=${encodeURIComponent(
      title,
    )}&applicationId=${encodeURIComponent(execution.applicationId)}`;
    return `<div class="actions"><a href="${esc(retryHref)}">Start a new attempt</a></div>`;
  }
  return `<div class="actions"><a href="/runs/${id}?action=cancel">Cancel this execution…</a></div>`;
}

/**
 * The primary result presentation: what was produced, is it complete, can
 * it be trusted, what to do next. Next actions follow the status family
 * (decision / failure / cancel / completed); a completed run with failed
 * checks renders the quality-failure notice (AC10's second dimension).
 *
 * WORK-038 AC1: the caller may supply `trustSummaryHtml` (the trust
 * module's four-axis summary, linked to the evidence) — rendered as the
 * "Can you trust it?" lead; the compact verification strip follows it.
 */
export interface ResultSurfaceView extends WhyPanelView {
  /** The WORK-038 trust summary (from the trust presentation module). */
  readonly trustSummaryHtml?: string;
}

export function resultSurface(view: ResultSurfaceView): string {
  const { execution, result, events } = view;
  const artifacts =
    result.outputArtifacts.length === 0
      ? emptyState(
          "No output artifacts",
          "This execution has not produced output artifacts (or has not reached that point yet).",
        )
      : `<table class="data">
    <thead><tr><th scope="col">Artifact</th><th scope="col">Digest</th><th scope="col">Created</th></tr></thead>
    <tbody>${result.outputArtifacts
      .map(
        (artifact) => `<tr>
      <td><a href="/assets/artifacts/${encodeURIComponent(
        artifact.id,
      )}?executionId=${encodeURIComponent(execution.id)}">${esc(artifact.id)}</a></td>
      <td class="mono">${artifact.digest === null ? "—" : esc(artifact.digest)}</td>
      <td class="mono">${esc(artifact.createdAt)}</td>
    </tr>`,
      )
      .join("")}</tbody>
  </table>`;
  const warnings =
    result.warnings.length === 0
      ? '<p class="muted">No warnings recorded.</p>'
      : `<ul>${result.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>`;
  const classification = classifyFailure(execution, result, events);
  const next =
    execution.status === "WAITING_USER" || execution.status === "WAITING_HUMAN"
      ? waitingSurface(execution, events)
      : execution.status === "FAILED"
        ? failedSurface(execution, result, events)
        : classification.dimension === "quality"
          ? qualityFailureNotice(execution, classification.failedChecks)
          : nextActions(execution, result);
  return `<section class="result-surface">
  <div class="detail-grid">
    <div>
      <h3>Produced artifacts</h3>
      ${artifacts}
      <h3>Completeness</h3>
      ${keyValueTable([
        ["Status", `${statusLabel(execution.status)} (${execution.status})`],
        ["Terminal at", execution.terminalAt ?? "— (still in progress)"],
      ])}
      <h3>Warnings</h3>
      ${warnings}
    </div>
    <div>
      ${view.trustSummaryHtml === undefined ? "<h3>Can you trust it?</h3>" : view.trustSummaryHtml}
      ${verificationSummary(result.verification, { compact: true, executionId: execution.id })}
    </div>
  </div>
  ${next}
</section>`;
}

/** Secret-shape guard re-export for component-level tests. */
export const secretGuard = { isSecretShapedKey, redactSecretShaped };

// ---------------------------------------------------------------------------
// WORK-037: the Build-experience components — the at-a-glance grids, the
// training/evaluation/release distinction list and the long-running
// workload section. Every fact is a platform fact or an explicit honest
// absence (the same discipline as every component above).
// ---------------------------------------------------------------------------

/**
 * The at-a-glance grid (AC3/AC4): a definition-style grid of labeled
 * cells, each marked whether a platform fact backs it ("Platform fact")
 * or the cell states the explicit absence ("Not exposed by the public
 * API"). The marker is text, never color alone.
 */
export function glanceGrid(cells: readonly GlanceFact[]): string {
  const items = cells
    .map(
      (cell) => `<div class="glance-cell">
  <h4>${esc(cell.label)}</h4>
  <p>${esc(cell.fact)}</p>
  <p class="glance-kind">${cell.backed ? "Platform fact" : "Not exposed by the public API"}</p>
</div>`,
    )
    .join("\n  ");
  return `<div class="glance-grid">
  ${items}
</div>`;
}

/**
 * A generic distinction row (WORK-038): label + fact + backed marker —
 * the shared shape behind the training-state and evaluation-status
 * distinction lists. Each row is its own fact, never merged.
 */
export interface DistinctionRow {
  readonly label: string;
  readonly fact: string;
  /** True when a live platform fact backs the row (drives the marker). */
  readonly backed: boolean;
}

/**
 * The generic distinction list: label / fact / marker rows — each its own
 * fact, never merged (the WORK-037 four-state list and the WORK-038
 * evaluation statuses both render through this one presentation).
 */
export function distinctionList(rows: readonly DistinctionRow[]): string {
  const items = rows
    .map(
      (row) => `<li>
  <span class="distinction-state">${esc(row.label)}</span>
  <span class="distinction-fact">${esc(row.fact)}</span>
  <span class="glance-kind">${row.backed ? "Platform fact" : "Explicit absence"}</span>
</li>`,
    )
    .join("\n  ");
  return `<ul class="distinction-list">
  ${items}
</ul>`;
}

/**
 * The four-state distinction list (AC7): compute complete / training
 * complete / evaluation passed / release approved — each row its own
 * fact, never merged, the release row always the explicit absence.
 */
export function trainingStateList(rows: readonly TrainingStateRow[]): string {
  return distinctionList(rows);
}

const RECOVERY_LABELS: Readonly<Record<WorkloadRecoveryKind, string>> = {
  recovered:
    "Recovered — the platform recorded a resume of this already-running execution (resume-recorded event).",
  "resume-denied":
    "A resume was denied by the platform's re-admission authority (resume-denied event) — the governed stop remains Cancel.",
  interrupted: "A human interruption was requested (interruption-requested event).",
  woken: "A scheduled wake-up was applied (wake-up-applied event).",
};

export interface WorkloadSectionView {
  readonly execution: Execution;
  readonly result: ExecutionResult;
  readonly workload: WorkloadFacts;
}

/**
 * The long-running workload section (AC8): progress, checkpoint recency,
 * spend and recovery state — derived ONLY from the platform's typed
 * event facts and the recorded cost facts. Lease/heartbeat mechanics are
 * platform-internal and are never exposed here (stated explicitly). The
 * training/evaluation/release distinction (AC7) renders inside, so a
 * workload's completion vocabulary is always the four distinct states.
 */
export function longRunningWorkloadSection(view: WorkloadSectionView): string {
  const { execution, result, workload } = view;
  const id = encodeURIComponent(execution.id);
  const progress = `<p>The chronological timeline is this workload's progress view — <a href="/runs/${id}?tab=activity">open the activity timeline</a>.</p>`;
  const checkpoint =
    workload.lastCheckpoint === null
      ? '<p class="muted">No checkpoint events are recorded on the public stream.</p>'
      : `<p>Checkpoint ${workload.lastCheckpoint.sequence} of ${workload.checkpointCount} recorded at ${esc(
          workload.lastCheckpoint.occurredAt,
        )}${
          workload.lastCheckpoint.lastEventPosition === null
            ? ""
            : ` (position ${workload.lastCheckpoint.lastEventPosition})`
        } — the platform's own checkpoint ledger fact.</p>`;
  const budget = declaredBudgetMicroUsd(execution);
  const spend =
    result.cost === null
      ? `<p class="muted">No settled cost is recorded yet.${
          budget === null
            ? ""
            : ` The declared budget constraint on the request is ${esc(formatMicroUsd(budget))}.`
        }</p>`
      : `<p>Settled cost: ${esc(formatMicroUsd(result.cost.totalMicroUsd))}.${
          budget === null
            ? ""
            : ` The declared budget constraint on the request is ${esc(formatMicroUsd(budget))}.`
        }</p>`;
  const recovery =
    workload.recovery === null
      ? '<p class="muted">No recovery events (resume, interruption, wake-up) are recorded on the public stream.</p>'
      : `<p>${esc(RECOVERY_LABELS[workload.recovery.kind])} Recorded at ${esc(
          workload.recovery.occurredAt,
        )}.</p>`;
  return `<section class="workload-facts" aria-labelledby="workload-facts-title">
  <h2 id="workload-facts-title">Long-running workload</h2>
  <p class="muted">This run's public event stream carries long-running workload facts. A workload is governed work through the execution authority — every fact below is the platform's own record; lease and heartbeat mechanics are platform-internal and are never shown here.</p>
  <h3>Progress</h3>
  ${progress}
  <h3>Checkpoint recency</h3>
  ${checkpoint}
  <h3>Spend</h3>
  ${spend}
  <h3>Recovery state</h3>
  ${recovery}
  <h3>Training, evaluation and release states</h3>
  <p class="muted">Four distinct states — never merged, and none implied by another.</p>
  ${trainingStateList(trainingStateRows(execution, result.verification))}
</section>`;
}
