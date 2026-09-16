/**
 * Zeck execution explorer module (DEP-012 — the complete execution
 * inspection surface over the public contracts).
 *
 * A PROJECTION, NEVER A SECOND AUTHORITY (DEP-012): this module holds NO
 * console-local source of truth and NO second execution, verification,
 * evidence, artifact, cost or event authority. Every fact it renders is
 * SOURCED from the public records the platform already exposes:
 *
 *   - the execution record   `GET /executions/:id` (identity, scope,
 *                            status, task, constraints, metadata,
 *                            timestamps);
 *   - the result record      `GET /executions/:id/results` (terminal
 *                            status, route summary, cost/usage, output
 *                            artifacts with digests, verification,
 *                            warnings);
 *   - the event ledger       `GET /executions/:id/events` (lifecycle,
 *                            planning, steps, verification, settlement —
 *                            causal order by sequence);
 *   - the verification axis  `GET /executions/:id/verification` (every
 *                            recorded check, outcome, evidence refs).
 *
 * Every fact those records do NOT carry renders as an honest unavailable
 * state NAMING the missing public contract — never invented, never
 * approximated from non-public internals (the DEP-010/012 honesty
 * doctrine). Artifact content is never rendered: references and digests
 * only.
 *
 * MACHINE PARITY (DEP-012 AC8): `explorerFactsOf` composes the SAME
 * public records into the plain object served (verbatim JSON) under
 * `GET /console/executions/:id/facts.json` — an agent follows an
 * execution without scraping HTML, and the HTML views and the machine
 * view CANNOT drift because both render from one composition.
 *
 * THE LIST (DEP-012 AC1): the public API exposes NO application-scoped
 * execution listing route — the list is this browser's recents (the
 * disclosed cookie), each row re-read live through the governed
 * `GET /executions/:id`, with the boundary named in the page.
 */

import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../sdk";
import { esc, formatMicroUsd, keyValueTable } from "./components";
import { type ConsoleFamily, consoleFamilies } from "./console";
import { chronologicalEvents, planningDecisionOf } from "./projection";
import { emptyState, errorState } from "./states";

// ---------------------------------------------------------------------------
// The view vocabulary (DEP-012: six linkable views, the established
// tab-nav pattern — static routes precede parameterized ones)
// ---------------------------------------------------------------------------

export const EXPLORER_VIEWS = [
  "result",
  "verification",
  "activity",
  "route",
  "costs",
  "provenance",
] as const;

export type ExplorerView = (typeof EXPLORER_VIEWS)[number];

const VIEW_LABELS: Readonly<Record<ExplorerView, string>> = {
  result: "Result",
  verification: "Verification",
  activity: "Activity",
  route: "Route & substrate",
  costs: "Costs",
  provenance: "Provenance",
};

export function explorerViewOf(raw: string | null): ExplorerView {
  return EXPLORER_VIEWS.find((view) => view === raw) ?? "result";
}

/** The tab nav over the six views (the house tabs pattern). */
export function explorerTabNav(executionId: string, active: ExplorerView): string {
  const id = encodeURIComponent(executionId);
  const tab = (view: ExplorerView): string =>
    `<a class="tab${view === active ? " active" : ""}" href="/console/executions/${id}?tab=${view}"${view === active ? ' aria-current="page"' : ""}>${esc(VIEW_LABELS[view])}</a>`;
  return `<nav class="tabs" aria-label="Execution views">
  ${EXPLORER_VIEWS.map(tab).join("\n  ")}
</nav>`;
}

// ---------------------------------------------------------------------------
// Family facts (the workload class of a run, from the record's own
// metadata — never re-derived from a console-local catalog)
// ---------------------------------------------------------------------------

const FAMILY_IDS: ReadonlySet<string> = new Set(
  consoleFamilies().map((f: ConsoleFamily) => f.family),
);

/**
 * The run's workload family when the record's metadata carries one that
 * the machine catalog also carries (the playground and validation lab
 * stamp `metadata.family`), else the task's own kind when the family
 * catalog knows that kind, else an honest unrecorded marker.
 */
export function explorerFamilyOf(execution: Execution): string {
  const metadataFamily = execution.metadata.family;
  if (typeof metadataFamily === "string" && FAMILY_IDS.has(metadataFamily)) {
    return metadataFamily;
  }
  const kind = execution.task.kind;
  if (typeof kind === "string" && FAMILY_IDS.has(kind)) {
    return kind;
  }
  return "unrecorded";
}

// ---------------------------------------------------------------------------
// List facts (the executions list — recents-derived, live re-read)
// ---------------------------------------------------------------------------

export interface ExplorerRunFact {
  readonly id: string;
  readonly family: string;
  readonly status: string;
  readonly createdAt: string;
  readonly terminalAt: string | null;
  readonly costMicroUsd: string | null;
  readonly origin: string | null;
}

/** Compose the list row facts from the live public records. */
export function explorerRunsOf(
  executions: readonly Execution[],
  results: ReadonlyMap<string, ExecutionResult>,
): readonly ExplorerRunFact[] {
  return executions.map((execution) => {
    const result = results.get(execution.id) ?? null;
    const origin = execution.metadata.origin;
    return {
      id: execution.id,
      family: explorerFamilyOf(execution),
      status: execution.status,
      createdAt: execution.createdAt,
      terminalAt: execution.terminalAt,
      costMicroUsd: result === null || result.cost === null ? null : result.cost.totalMicroUsd,
      origin: typeof origin === "string" ? origin : null,
    };
  });
}

/** The machine shape of one list row (facts.json parity for the list). */
export function explorerListFactsJson(
  facts: readonly ExplorerRunFact[],
): Readonly<Record<string, unknown>> {
  return {
    note: "The public API exposes no application-scoped execution listing route; this list is the browser's disclosed recents, each row re-read live through GET /executions/:id.",
    runs: facts,
  };
}

// ---------------------------------------------------------------------------
// The six views (each renders ONLY public-record facts)
// ---------------------------------------------------------------------------

export interface ExplorerFacts {
  readonly execution: Execution;
  readonly result: ExecutionResult;
  readonly events: readonly ExecutionEvent[];
  readonly verification: readonly VerificationResult[];
}

/** Compose the machine facts (served verbatim at facts.json). */
export function explorerFactsOf(facts: ExplorerFacts): Readonly<Record<string, unknown>> {
  const { execution, result, events, verification } = facts;
  const decision = planningDecisionOf(events);
  return {
    source: {
      records: [
        "GET /executions/:id",
        "GET /executions/:id/results",
        "GET /executions/:id/events",
        "GET /executions/:id/verification",
      ],
      note: "Composed public records, verbatim — no console-derived facts are added.",
    },
    execution,
    result,
    events: chronologicalEvents(events),
    verification,
    derived: {
      family: explorerFamilyOf(execution),
      planningDecision: decision,
    },
  };
}

/** Result — terminal status, output artifacts (digests), usage, warnings. */
export function explorerResultView(facts: ExplorerFacts): string {
  const { execution, result } = facts;
  const artifacts =
    result.outputArtifacts.length === 0
      ? emptyState(
          "No output artifacts",
          "This execution recorded no output artifacts — artifact references appear here when the platform records them on the result record.",
        )
      : `<ul class="lineage-list">${result.outputArtifacts
          .map(
            (artifact) =>
              `<li><a class="evidence-ref" href="/assets/artifacts/${encodeURIComponent(
                artifact.id,
              )}?executionId=${encodeURIComponent(execution.id)}">${esc(artifact.id)}</a>${
                artifact.digest === null
                  ? '\n    <span class="muted">(no digest recorded)</span>'
                  : `\n    <span class="muted mono">${esc(artifact.digest)}</span>`
              }</li>`,
          )
          .join("\n    ")}</ul>`;
  const warnings =
    result.warnings.length === 0
      ? '<p class="muted">No warnings recorded.</p>'
      : `<ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`;
  return `<h2>Result</h2>
${keyValueTable([
  ["terminal status", esc(execution.status)],
  [
    "terminal at",
    execution.terminalAt === null ? "— (not terminal yet)" : esc(execution.terminalAt),
  ],
  [
    "usage",
    result.usage === null
      ? "— (no usage recorded)"
      : `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`,
  ],
  [
    "recorded route",
    result.route === null
      ? "— (no route recorded)"
      : esc(result.route.strategyClass ?? "unrecorded class"),
  ],
])}
<h3>Output artifacts (references and digests only)</h3>
${artifacts}
<h3>Warnings</h3>
${warnings}
<p class="muted">The output payload itself is not exposed by the public API — artifacts render as references and content digests, never content (the established doctrine).</p>`;
}

/** Verification — every recorded check, outcome, evidence reference. */
export function explorerVerificationView(facts: ExplorerFacts): string {
  const { verification, result } = facts;
  const rows = [...verification]
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))
    .map(
      (check) => `<tr>
      <td class="mono">${esc(check.criterionId)}</td>
      <td>${esc(check.status)}</td>
      <td class="mono">${esc(check.strategy)}</td>
      <td>${
        check.evidenceRefs.length === 0
          ? '<span class="muted">—</span>'
          : check.evidenceRefs.map((ref) => `<span class="mono">${esc(ref)}</span>`).join(", ")
      }</td>
      <td>${check.confidence === null ? '<span class="muted">—</span>' : esc(check.confidence)}</td>
      <td class="mono">${esc(check.evaluator.kind)}</td>
    </tr>`,
    )
    .join("");
  const table =
    verification.length === 0
      ? emptyState(
          "No verification results",
          "No verification checks are recorded for this execution — the verification axis renders here when the platform records them (GET /executions/:id/verification).",
        )
      : `<table class="data">
  <thead><tr><th scope="col">Check</th><th scope="col">Outcome</th><th scope="col">Strategy</th><th scope="col">Evidence refs</th><th scope="col">Confidence</th><th scope="col">Evaluator</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  const resultAxis =
    result.verification.length === 0
      ? ""
      : `<p class="muted">The result record carries ${result.verification.length} verification fact(s) at settlement time; the table above is the full recorded axis.</p>`;
  return `<h2>Verification</h2>
<p class="muted">Every verification result recorded for this run — check, outcome and evidence reference. The console NEVER re-verifies: this is the recorded axis, read-only.</p>
${table}
${resultAxis}`;
}

/** Activity — the event ledger in causal order. */
export function explorerActivityView(facts: ExplorerFacts): string {
  const ordered = chronologicalEvents(facts.events);
  const rows = ordered
    .map(
      (event) => `<tr>
      <td>${esc(event.sequence)}</td>
      <td class="mono">${esc(event.type)}</td>
      <td class="mono">${esc(event.eventId)}</td>
      <td class="mono">${esc(event.occurredAt)}</td>
    </tr>`,
    )
    .join("");
  const table =
    ordered.length === 0
      ? emptyState(
          "No events",
          "The public event stream is empty for this execution (GET /executions/:id/events).",
        )
      : `<table class="data">
  <thead><tr><th scope="col">#</th><th scope="col">Type</th><th scope="col">Event id</th><th scope="col">Occurred</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  return `<h2>Activity</h2>
<p class="muted">The event ledger in causal order — lifecycle transitions, planning decisions, execution steps, verification and settlement events, exactly as the public stream records them.</p>
${table}`;
}

/** Route & substrate — route summary, capability facts, substrate, agents. */
export function explorerRouteView(facts: ExplorerFacts): string {
  const { result, events } = facts;
  const decision = planningDecisionOf(events);
  const route =
    result.route === null
      ? emptyState(
          "No route recorded",
          "The result record carries no route summary — the route facts render here when the platform records them (GET /executions/:id/results → route).",
        )
      : keyValueTable([
          ["provider", result.route.provider ?? "(deterministic — no provider call)"],
          ["model", result.route.model ?? "—"],
          ["strategy class", result.route.strategyClass ?? "—"],
          ["model calls", String(result.route.modelCalls)],
        ]);
  const substrate =
    decision === null || decision.substrate === null
      ? emptyState(
          "No substrate selection recorded",
          "The planning decision's substrate capture renders here when the event stream carries one (planning.decision-recorded → substrate).",
        )
      : keyValueTable([
          ["substrate", decision.substrate.selectedSubstrateId ?? "(none selected)"],
          ["version", decision.substrate.selectedVersion ?? "—"],
          ["workload class", decision.substrate.workloadClass ?? "—"],
          ["outcome", decision.substrate.outcome ?? "—"],
        ]);
  const capabilities =
    decision === null
      ? emptyState(
          "No capability resolution recorded",
          "Capability/workload facts render here when the event stream carries the planning decision's capability resolution.",
        )
      : keyValueTable([
          [
            "capabilities satisfied",
            decision.capabilitySatisfied === null ? "—" : String(decision.capabilitySatisfied),
          ],
          ["catalog revision", decision.capabilityCatalogRevision ?? "—"],
          [
            "unmet capabilities",
            decision.unmetCapabilityIds.length === 0
              ? "none"
              : decision.unmetCapabilityIds.join(", "),
          ],
        ]);
  const agentEvents = chronologicalEvents(events).filter((event) => /agent|tool/i.test(event.type));
  const agents =
    agentEvents.length === 0
      ? emptyState(
          "No agent/tool participation recorded",
          "Agent and tool participation facts render here when the public event stream carries them — the console never infers participation from non-public internals.",
        )
      : `<ul class="lineage-list">${agentEvents
          .map(
            (event) =>
              `<li><span class="mono">${esc(event.type)}</span> <span class="muted">#${esc(
                event.sequence,
              )}</span></li>`,
          )
          .join("\n    ")}</ul>`;
  return `<h2>Route &amp; substrate</h2>
<p class="muted">The recorded route summary, capability resolution and compute substrate — provider and model are recorded facts, never the primary mental model.</p>
<h3>Route summary</h3>
${route}
<h3>Capability resolution</h3>
${capabilities}
<h3>Compute substrate</h3>
${substrate}
<h3>Agent / tool participation</h3>
${agents}`;
}

/** Costs — the recorded cost and usage facts, boundaries named. */
export function explorerCostsView(facts: ExplorerFacts): string {
  const { result, execution } = facts;
  const cost =
    result.cost === null
      ? emptyState(
          "No cost recorded",
          "The result record carries no cost summary — recorded cost facts render here when the platform settles them (GET /executions/:id/results → cost).",
        )
      : keyValueTable([
          [
            "recorded cost",
            `$${esc(formatMicroUsd(result.cost.totalMicroUsd))} (${esc(result.cost.totalMicroUsd)} micro-USD, ${esc(result.cost.currency)})`,
          ],
        ]);
  const constraints = execution.constraints;
  const budget =
    constraints === null
      ? '<p class="muted">No constraints were recorded on the create request.</p>'
      : keyValueTable([
          [
            "max cost",
            typeof constraints.maxCostMicroUsd === "string"
              ? `$${esc(formatMicroUsd(constraints.maxCostMicroUsd))}`
              : "—",
          ],
          [
            "max latency",
            typeof constraints.maxLatencyMs === "number" ? `${constraints.maxLatencyMs} ms` : "—",
          ],
        ]);
  return `<h2>Costs</h2>
<p class="muted">The durable ledger's recorded cost and usage facts for this run.</p>
<h3>Recorded cost</h3>
${cost}
<h3>Requested constraints</h3>
${budget}
${emptyState(
  "Per-step and per-model cost breakdown",
  "The public API does not expose a per-step or per-model cost breakdown — only the settled total. This boundary renders honestly rather than approximating from non-public internals.",
  "Missing contract: a cost-breakdown projection over GET /executions/:id/results",
)}`;
}

/** Provenance — scope, identity, idempotency semantics, timestamps, lineage. */
export function explorerProvenanceView(facts: ExplorerFacts): string {
  const { execution } = facts;
  const metadataRows = Object.entries(execution.metadata)
    .map(
      ([key, value]) =>
        `<tr><td class="mono">${esc(key)}</td><td class="mono">${esc(JSON.stringify(value))}</td></tr>`,
    )
    .join("");
  const metadata =
    metadataRows.length === 0
      ? '<p class="muted">No metadata was recorded on the create request.</p>'
      : `<table class="data"><thead><tr><th scope="col">Key</th><th scope="col">Value</th></tr></thead><tbody>${metadataRows}</tbody></table>`;
  return `<h2>Provenance</h2>
<p class="muted">Application/environment scope, request identity, idempotency semantics, timestamps and lineage — exactly what the public records carry.</p>
${keyValueTable([
  ["execution id", esc(execution.id)],
  ["application scope", esc(execution.applicationId)],
  ["environment", execution.environmentId === null ? "default" : esc(execution.environmentId)],
  ["created at", esc(execution.createdAt)],
  ["updated at", esc(execution.updatedAt)],
  [
    "terminal at",
    execution.terminalAt === null ? "— (not terminal yet)" : esc(execution.terminalAt),
  ],
])}
<h3>Request metadata (lineage the create request carried)</h3>
${metadata}
${emptyState(
  "Request identity and idempotency key",
  "The public records do not expose the request's Idempotency-Key or request-identity facts — the idempotency SEMANTICS are governed by the create contract (same key + same fingerprint replays the same durable outcome), but the key itself is not a readable fact.",
  "Missing contract: a request-identity projection over GET /executions/:id",
)}`;
}

/** The not-found honest state for an unknown/invisible execution. */
export function explorerNotFoundView(executionId: string): string {
  return errorState(
    "This execution is not visible through the governed API",
    `No execution "${executionId}" was returned — it may belong to another application or not exist. The console can only see executions the API authorizes for this token.`,
    "GET /executions/:id through the Zeck SDK client",
  );
}

/** Render one view by id (the router's single dispatch point). */
export function explorerView(view: ExplorerView, facts: ExplorerFacts): string {
  switch (view) {
    case "verification":
      return explorerVerificationView(facts);
    case "activity":
      return explorerActivityView(facts);
    case "route":
      return explorerRouteView(facts);
    case "costs":
      return explorerCostsView(facts);
    case "provenance":
      return explorerProvenanceView(facts);
    case "result":
      return explorerResultView(facts);
  }
}
