/**
 * Zeck dashboard components — typed functions returning escaped HTML
 * (WORK-033). The zero-dependency, server-rendered component system.
 *
 * Every component is a PURE function over public wire shapes and derived
 * view-model values: no state, no network, no caching. All interpolated
 * values pass through `esc` (the one escape boundary). Status is always
 * communicated by symbol + text, never color alone. Money is rendered
 * from integer micro-USD strings with BigInt arithmetic only.
 */

import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../sdk";
import {
  type AttentionItem,
  deriveConfidenceChip,
  deriveQualityAxis,
  eventStageLabel,
  executionTitle,
  isSecretShapedKey,
  redactSecretShaped,
  safeTaskPairs,
  statusLabel,
  statusSymbol,
} from "./projection";

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

/** Reusable collapsed-by-default disclosure for expert fields. */
export function advancedDisclosure(
  summary: string,
  content: string,
  options: { readonly id?: string } = {},
): string {
  return `<details class="advanced"${options.id === undefined ? "" : ` id="${esc(options.id)}"`}><summary>${esc(
    summary,
  )}</summary><div class="advanced-body">${content}</div></details>`;
}

// ---------------------------------------------------------------------------
// State primitives (loading/empty/error/permission-denied/unavailable family)
// ---------------------------------------------------------------------------

function stateBlock(className: string, title: string, body: string, source?: string): string {
  return `<div class="state ${className}">
  <p class="state-title">${esc(title)}</p>
  <p class="state-body">${esc(body)}</p>${source === undefined ? "" : `\n  <p class="state-source">${esc(source)}</p>`}
</div>`;
}

export function emptyState(title: string, body: string, hint?: string): string {
  return stateBlock("state-empty", title, body, hint);
}

export function errorState(title: string, body: string, detail?: string): string {
  return stateBlock("state-error", title, body, detail);
}

/**
 * The honest "not yet exposed by the public API" state: a one-line
 * explanation of the concept in user language and a pointer to where its
 * facts WILL come from. NEVER a fabricated placeholder.
 */
export function unavailableState(
  concept: string,
  explanation: string,
  futureSource: string,
): string {
  return `<div class="state state-unavailable">
  <p class="state-title">${esc(concept)} — not yet exposed by the public API</p>
  <p class="state-body">${esc(explanation)}</p>
  <p class="state-source">When this surface ships, its facts will come from ${esc(futureSource)}.</p>
</div>`;
}

export function permissionDeniedState(title: string, body: string, detail?: string): string {
  return stateBlock("state-denied", title, body, detail);
}

// ---------------------------------------------------------------------------
// Execution header (UX §6.1)
// ---------------------------------------------------------------------------

export interface ExecutionHeaderView {
  readonly execution: Execution;
  readonly durationMs: number;
  readonly costMicroUsd: string | null;
  readonly verificationChip: string | null;
  readonly now?: number;
}

export function executionHeader(view: ExecutionHeaderView): string {
  const { execution } = view;
  const title = executionTitle(execution.task, execution.id);
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
  return `<header class="execution-header">
  <div class="title-line">
    <h1>${esc(title)}</h1>
    ${statusBadge(execution.status)}
  </div>
  <div class="facts">${facts.join("\n    ")}</div>
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
 */
export function verificationSummary(
  verification: readonly VerificationResult[],
  options: { readonly compact?: boolean; readonly executionId?: string } = {},
): string {
  if (verification.length === 0) {
    return stateBlock(
      "state-empty",
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
    <td class="mono">${check.evidenceRefs.map((ref) => esc(ref)).join(", ")}</td>
    <td class="mono">${esc(check.recordedAt)}</td>
  </tr>`,
    )
    .join("");
  return `<div class="verification-table">
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
 * The persistent `<details>` disclosure above the tabs. Route (provider /
 * model) is SECONDARY detail nested inside its own advanced disclosure —
 * never the primary mental model.
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
  return `<details class="why-panel">
  <summary>How Zeck did it</summary>
  <div class="why-body">
    <h3>Understood task</h3>
    ${understood}
    <h3>Plan</h3>
    ${planSteps}
    <p class="muted">Strategy class: ${strategy}</p>
    <h3>Capabilities</h3>
    <p class="muted">capability detail is not exposed by this projection</p>
    <h3>Route</h3>
    <p class="muted">Provider and model are secondary details of the governed route.</p>
    ${advancedDisclosure("Route detail (advanced)", route)}
    <h3>Compute</h3>
    <p>${execution.environmentId === null ? "default" : esc(execution.environmentId)}</p>
    <h3>Why this route</h3>
    ${whyRoute}
    <h3>Cost</h3>
    ${cost}
  </div>
</details>`;
}

// ---------------------------------------------------------------------------
// Attention card (UX §4, §8)
// ---------------------------------------------------------------------------

export function attentionCard(item: AttentionItem): string {
  const links = item.links
    .map((link) => `<a href="${esc(link.href)}">${esc(link.label)}</a>`)
    .join(" ");
  return `<article class="attention-card attention-${esc(item.kind)}">
  <p class="card-title">${esc(item.title)}</p>
  <p class="card-body">${esc(item.body)}</p>
  <p class="card-actions">${links}</p>
</article>`;
}

export function attentionArea(items: readonly AttentionItem[]): string {
  if (items.length === 0) {
    return "";
  }
  return `<section class="attention-area" aria-label="Needs your attention">
  ${items.map(attentionCard).join("\n  ")}
</section>`;
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
  return `<section class="waiting-surface card">
  <h3>Decision needed</h3>
  <p>Zeck is waiting: this is a normal governed execution state, not an error.</p>
  ${known}
  <p class="muted">The public API does not expose a resolve command for this wait. Resolve it through your application's governed path, or cancel the execution.</p>
  <div class="actions"><a class="button-link" href="/runs/${encodeURIComponent(
    execution.id,
  )}?action=cancel">Cancel this execution</a></div>
</section>`;
}

function failedSurface(execution: Execution, events: readonly ExecutionEvent[]): string {
  const failEvent = lastEventOfType(events, (type) => type.includes("fail"));
  const stage = failEvent === undefined ? null : eventStageLabel(failEvent.type);
  const message = payloadMessage(failEvent);
  const title = executionTitle(execution.task, execution.id);
  const retryHref = `/build/execution?outcome=${encodeURIComponent(
    title,
  )}&applicationId=${encodeURIComponent(execution.applicationId)}`;
  return `<section class="failure-surface card">
  <h3>Zeck could not complete this execution</h3>
  <p>The execution reached the terminal state Failed.</p>
  ${
    stage === null
      ? '<p class="muted">No failure-bearing event is recorded in the public event stream.</p>'
      : `<p>Last recorded failure event: <strong>${esc(stage)}</strong>${
          message === null ? "" : ` — ${esc(message)}`
        }</p>`
  }
  <div class="actions">
    <a href="/runs/${encodeURIComponent(execution.id)}?tab=activity">View activity</a>
    <a href="/runs/${encodeURIComponent(execution.id)}?tab=evidence">View evidence</a>
    <a href="${esc(retryHref)}">Start a new attempt</a>
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
 * (decision / failure / cancel / completed).
 */
export function resultSurface(view: WhyPanelView): string {
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
  const next =
    execution.status === "WAITING_USER" || execution.status === "WAITING_HUMAN"
      ? waitingSurface(execution, events)
      : execution.status === "FAILED"
        ? failedSurface(execution, events)
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
      <h3>Can you trust it?</h3>
      ${verificationSummary(result.verification, { compact: true, executionId: execution.id })}
    </div>
  </div>
  ${next}
</section>`;
}

/** Secret-shape guard re-export for component-level tests. */
export const secretGuard = { isSecretShapedKey, redactSecretShaped };
