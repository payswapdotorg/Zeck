/**
 * Zeck playground compare module (DEP-031 — the baseline-vs-strategy
 * comparison projection over the public execution records).
 *
 * A PROJECTION, NEVER A SECOND COMPARATOR AUTHORITY (DEP-031): compare is a
 * projection over execution records. This module holds NO console-local
 * benchmark, evaluation, scoring or aggregation state — the validation
 * program's comparator harness (benchmarks/validation) is the established
 * comparison machinery, and this surface projects the SAME composition
 * discipline into the playground console. Every fact it renders is SOURCED
 * from the public records the platform already exposes (the SAME records
 * the execution explorer composes):
 *
 *   - the execution record   `GET /executions/:id` (identity, scope,
 *                            status, task, constraints, lineage metadata,
 *                            timestamps);
 *   - the result record      `GET /executions/:id/results` (terminal
 *                            outcome, settled cost, provider-reported
 *                            usage, route summary, output artifacts with
 *                            digests, warnings);
 *   - the event ledger       `GET /executions/:id/events` (the planning
 *                            decision's own recorded facts — rendered
 *                            VERBATIM, never re-derived console-side);
 *   - the verification axis  `GET /executions/:id/verification` (every
 *                            recorded check with outcome and evidence).
 *
 * The side-by-side view renders status, terminal outcome, recorded
 * cost/usage, route summary, verification outcomes and duration — every
 * fact from the public records. The explanation panel renders the
 * platform's OWN recorded planning rationale (the planning-decision facts
 * the event ledger carries: deterministic-first sufficiency outcome,
 * candidate strategies with expected cost/quality/latency, the selected
 * strategy, the selection rationale, the substrate selection) exactly as
 * `planningDecisionOf` reads them — the console never re-derives,
 * approximates or scores a strategy.
 *
 * MACHINE PARITY (DEP-031 AC4): `composeCompare` is the ONE composition;
 * the HTML view and the JSON view (`GET /console/compare/facts.json?a=&b=`)
 * both render from it, so they cannot drift. The machine view embeds each
 * run's facts VERBATIM as `explorerFactsOf` composes them — the same
 * composition `GET /console/executions/:id/facts.json` serves per run —
 * so an agent can verify the compare against the per-run machine views
 * byte-for-byte.
 *
 * THE BASELINE LAUNCHER (DEP-031 AC3): the same composed task, the same
 * frozen public create contract — the request carries the baseline LINEAGE
 * metadata the platform records (`metadata.baseline`,
 * `metadata.baselineOf`), NEVER a provider/model override (provider
 * selection is structurally impossible in the frozen create contract; the
 * request is built from the source run's RECORDED public facts, exactly
 * the reproduction-recipe discipline of DEP-032). A true baseline — a
 * plain single-model execution planned on request — needs baseline
 * PLANNING semantics the public create contract does not carry, so the
 * launcher renders the honest unavailable state NAMING the missing
 * contract, and the need is recorded as a merge note for the Lead (a
 * console order never widens the frozen create vocabulary).
 *
 * HONEST BOUNDARIES (DEP-031 AC7): runs of different workload families
 * compare only on the generic axes and the view says so; missing facts
 * (e.g. realized quality scores the public API does not expose) render as
 * honest unavailable states naming the missing contract — never invented,
 * never approximated.
 */

import type { Execution, ExecutionRequest, ExecutionResult, ZeckClient } from "../../sdk";
import { ZeckApiError } from "../../sdk";
import { esc, formatDuration, formatMicroUsd, keyValueTable, statusBadge } from "./components";
import {
  inFlightCount,
  PLAYGROUND_BUDGET_LIMIT_DOLLARS,
  PLAYGROUND_BUDGET_LIMIT_MICRO_USD,
  PLAYGROUND_LATENCY_LIMIT_MS,
  PLAYGROUND_MAX_CONCURRENT_RUNS,
  PLAYGROUND_ORIGIN,
} from "./console";
import {
  type ExplorerFacts,
  type ExplorerRunFact,
  explorerFactsOf,
  explorerFamilyOf,
  explorerRunsOf,
} from "./explorer";
import {
  type HandlerResult,
  type HttpContext,
  htmlResult,
  htmlStatusResult,
  redirectResult,
  serializeCookie,
} from "./http";
import { modeOf } from "./modes";
import {
  APPEARANCE_COOKIE,
  addRecent,
  type PlanningDecisionFact,
  parseRecents,
  planningDecisionOf,
  RECENTS_COOKIE,
  serializeRecents,
} from "./projection";
import { type Appearance, appShell, pageHead } from "./shell";
import { confirmationCard, emptyState, errorState, unavailableState } from "./states";

// ---------------------------------------------------------------------------
// The baseline lineage vocabulary + the honest missing-contract boundary
// ---------------------------------------------------------------------------

/**
 * The baseline lineage value the launcher stamps: the developer REQUESTED a
 * single-model baseline. The platform records this lineage; it does NOT
 * change planning semantics (the create contract carries no baseline
 * vocabulary) — the view states exactly that, never implying the platform
 * forced a single model.
 */
export const COMPARE_BASELINE_LINEAGE = "single-model-baseline-requested";

/** The missing public contract a true baseline needs (named, never widened). */
export const BASELINE_MISSING_CONTRACT =
  "a create-contract extension carrying baseline planning semantics (e.g. a planning.baseline request vocabulary asking the platform to plan a plain single-model execution)";

/** One explicit boundary: a fact the public records do not carry. */
export interface CompareBoundary {
  readonly field: string;
  readonly statement: string;
  /** The missing public contract that would carry the fact, when named. */
  readonly missingContract?: string;
}

/** The honest unavailable state for the missing baseline planning semantics. */
export function baselineSemanticsBoundaryView(): string {
  return unavailableState(
    "True single-model baseline planning semantics",
    "The baseline launcher below re-submits the SAME composed task through the SAME frozen public create contract, carrying the baseline lineage metadata the platform records (metadata.baseline, metadata.baselineOf). The planning semantics are UNCHANGED: the frozen create contract's vocabulary is closed — no provider, model, rail, connection or agent selection exists or could exist — and the platform plans every run under its own governed strategy selection. A true plain single-model baseline needs a create-contract extension; this console order never widens the frozen vocabulary, and the need is recorded as a merge note for the Lead.",
    BASELINE_MISSING_CONTRACT,
  );
}

// ---------------------------------------------------------------------------
// The per-run record read (the explorer's own four-call fan-out)
// ---------------------------------------------------------------------------

/**
 * Read one run's full public facts (execution + result + events +
 * verification). Null when the id is invisible through the governed API
 * (a 404 on any of the four reads); every other error propagates
 * fail-closed.
 */
export async function readCompareFacts(
  client: ZeckClient,
  executionId: string,
): Promise<ExplorerFacts | null> {
  try {
    const [execution, result, events, verification] = await Promise.all([
      client.getExecution(executionId),
      client.getResult(executionId),
      client.listEvents(executionId),
      client.listVerification(executionId),
    ]);
    return { execution, result, events, verification };
  } catch (error) {
    if (error instanceof ZeckApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Derived per-side facts (arithmetic and counting over recorded facts only)
// ---------------------------------------------------------------------------

/** The baseline lineage a run's own metadata records (never re-derived). */
export interface CompareBaselineLineage {
  readonly baseline: string | null;
  readonly baselineOf: string | null;
}

function stringMetadata(metadata: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The recorded lineage chips of a run (origin, composed, baseline lineage). */
export function baselineLineageOf(execution: Execution): CompareBaselineLineage {
  return {
    baseline: stringMetadata(execution.metadata, "baseline"),
    baselineOf: stringMetadata(execution.metadata, "baselineOf"),
  };
}

/**
 * The run's duration in ms, derived by plain arithmetic over the RECORDED
 * timestamps (createdAt → terminalAt). Null when either timestamp is
 * missing, unparseable or inverted — never a guess.
 */
export function compareDurationMsOf(createdAt: string, terminalAt: string | null): number | null {
  if (terminalAt === null) {
    return null;
  }
  const start = Date.parse(createdAt);
  const end = Date.parse(terminalAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return end - start;
}

/** The verification axis's outcome counts (counting, never judging). */
export interface CompareVerificationSummary {
  readonly pass: number;
  readonly fail: number;
  readonly inconclusive: number;
  readonly total: number;
}

function verificationSummaryOf(
  verification: readonly { readonly status: string }[],
): CompareVerificationSummary {
  let pass = 0;
  let fail = 0;
  let inconclusive = 0;
  for (const check of verification) {
    if (check.status === "PASS") {
      pass += 1;
    } else if (check.status === "FAIL") {
      fail += 1;
    } else {
      inconclusive += 1;
    }
  }
  return { pass, fail, inconclusive, total: verification.length };
}

/** One side of the compare: the public facts, projected for side-by-side rendering. */
export interface CompareSideFact {
  readonly executionId: string;
  /** The run's application scope (the record's own fact). */
  readonly applicationId: string;
  readonly family: string;
  readonly status: string;
  readonly createdAt: string;
  readonly terminalAt: string | null;
  /** Derived from the recorded timestamps; null when not derivable. */
  readonly durationMs: number | null;
  readonly costMicroUsd: string | null;
  readonly currency: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly strategyClass: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly modelCalls: number | null;
  readonly verification: CompareVerificationSummary;
  readonly warningsCount: number;
  readonly artifactCount: number;
  readonly artifactReferences: readonly {
    readonly id: string;
    readonly digest: string | null;
  }[];
  readonly lineage: {
    readonly origin: string | null;
    readonly composed: string | null;
    readonly baseline: string | null;
    readonly baselineOf: string | null;
  };
  /** The platform's own recorded planning decision (verbatim), or null. */
  readonly planningDecision: PlanningDecisionFact | null;
}

/** Project one run's public facts into the side-by-side shape. */
export function compareSideOf(facts: ExplorerFacts): CompareSideFact {
  const { execution, result, events, verification } = facts;
  return {
    executionId: execution.id,
    applicationId: execution.applicationId,
    family: explorerFamilyOf(execution),
    status: execution.status,
    createdAt: execution.createdAt,
    terminalAt: execution.terminalAt,
    durationMs: compareDurationMsOf(execution.createdAt, execution.terminalAt),
    costMicroUsd: result.cost === null ? null : result.cost.totalMicroUsd,
    currency: result.cost === null ? null : result.cost.currency,
    inputTokens: result.usage === null ? null : result.usage.inputTokens,
    outputTokens: result.usage === null ? null : result.usage.outputTokens,
    strategyClass: result.route === null ? null : result.route.strategyClass,
    provider: result.route === null ? null : result.route.provider,
    model: result.route === null ? null : result.route.model,
    modelCalls: result.route === null ? null : result.route.modelCalls,
    verification: verificationSummaryOf(verification),
    warningsCount: result.warnings.length,
    artifactCount: result.outputArtifacts.length,
    artifactReferences: result.outputArtifacts.map((artifact) => ({
      id: artifact.id,
      digest: artifact.digest,
    })),
    lineage: {
      origin: stringMetadata(execution.metadata, "origin"),
      composed: stringMetadata(execution.metadata, "composed"),
      ...baselineLineageOf(execution),
    },
    planningDecision: planningDecisionOf(events),
  };
}

// ---------------------------------------------------------------------------
// The composition (ONE object drives the HTML AND the JSON view)
// ---------------------------------------------------------------------------

/** One composed-task field compared across the two runs (recorded values). */
export interface CompareTaskField {
  readonly key: string;
  /** The recorded value as JSON (data, never rendered raw). */
  readonly a: string;
  readonly b: string;
  readonly equal: boolean;
}

/** The whole composition — the compare projection over two runs. */
export interface CompareComposition {
  readonly selection: { readonly a: string; readonly b: string };
  readonly sameFamily: boolean;
  readonly families: { readonly a: string; readonly b: string };
  /** True when the families differ: generic axes only, and the view says so. */
  readonly genericAxesOnly: boolean;
  readonly sides: { readonly a: CompareSideFact; readonly b: CompareSideFact };
  readonly taskDelta: {
    readonly comparable: boolean;
    readonly note: string;
    readonly fields: readonly CompareTaskField[];
  };
  readonly boundaries: readonly CompareBoundary[];
  /** The raw public facts both sides render from (the machine view embeds them verbatim). */
  readonly facts: { readonly a: ExplorerFacts; readonly b: ExplorerFacts };
}

function jsonValueOf(value: unknown): string {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

/** The boundaries that hold for EVERY compare (doctrine-level). */
function universalBoundaries(): readonly CompareBoundary[] {
  return [
    {
      field: "realizedQualityScores",
      statement:
        "The public records carry no realized quality score for either run — the planning decision records the planner's EXPECTED quality per candidate and the verification axis records check outcomes, but no post-hoc quality score crosses the public API. The compare renders exactly those recorded facts; it never scores a run itself.",
      missingContract: "a realized-quality projection over GET /executions/:id",
    },
    {
      field: "baselinePlanningSemantics",
      statement:
        "A true baseline — a plain single-model execution planned on request — needs baseline planning semantics the public create contract does not carry: its vocabulary is closed (no provider/model/strategy selection exists or could exist) and the platform plans every run under its own governed strategy selection. The baseline launcher re-submits the same composed task with the baseline lineage metadata the platform records; the planning semantics are unchanged.",
      missingContract: BASELINE_MISSING_CONTRACT,
    },
    {
      field: "statisticalComparison",
      statement:
        "One run compared with one run is not a statistical comparison. This surface projects the two runs' recorded public facts side by side — it computes no aggregate, no score and no winner. The validation program's comparator harness (benchmarks/validation) is the established comparison machinery; this console surface is its projection into the playground, never a second comparator authority.",
    },
    {
      field: "perStepCostBreakdown",
      statement:
        "The public API exposes no per-step or per-model cost breakdown — only the settled per-run total (GET /executions/:id/results). The compare reports exactly that.",
      missingContract: "a cost-breakdown projection over GET /executions/:id/results",
    },
  ];
}

/**
 * Compose the compare of two runs: the side-by-side public facts, the
 * recorded planning decisions (verbatim), the composed-task delta (same
 * family only), and the explicit boundaries. Pure over its inputs — every
 * fact is read from the two ExplorerFacts records, nothing is invented.
 */
export function composeCompare(a: ExplorerFacts, b: ExplorerFacts): CompareComposition {
  const sideA = compareSideOf(a);
  const sideB = compareSideOf(b);
  const sameFamily = sideA.family === sideB.family;
  const boundaries = [...universalBoundaries()];
  const taskKeys = [
    ...new Set([...Object.keys(a.execution.task), ...Object.keys(b.execution.task)]),
  ].sort();
  const fields: CompareTaskField[] = taskKeys.map((key) => {
    const valueA = jsonValueOf(a.execution.task[key]);
    const valueB = jsonValueOf(b.execution.task[key]);
    return { key, a: valueA, b: valueB, equal: valueA === valueB };
  });
  const taskDelta = sameFamily
    ? {
        comparable: true,
        note: "The two runs' recorded composed tasks, field by field — the RECORDED values, exactly as each create request carried them.",
        fields,
      }
    : {
        comparable: false,
        note: "Runs of different workload families compare only on the generic axes (status, cost, usage, route, verification, duration) — the composed task shapes are not comparable across families and are not rendered side by side.",
        fields: [],
      };
  if (!sameFamily) {
    boundaries.push({
      field: "differentWorkloadFamilies",
      statement: `Run a is of family "${sideA.family}" and run b of family "${sideB.family}" — different workload families. Only the generic axes are compared; the family-specific composed task shapes are not.`,
    });
  }
  return {
    selection: { a: a.execution.id, b: b.execution.id },
    sameFamily,
    families: { a: sideA.family, b: sideB.family },
    genericAxesOnly: !sameFamily,
    sides: { a: sideA, b: sideB },
    taskDelta,
    boundaries,
    facts: { a, b },
  };
}

// ---------------------------------------------------------------------------
// The machine view (GET /console/compare/facts.json — parity by construction)
// ---------------------------------------------------------------------------

/**
 * The machine compare view: the SAME composition the HTML renders, with
 * each run's facts embedded VERBATIM as `explorerFactsOf` composes them
 * (the same composition GET /console/executions/:id/facts.json serves per
 * run — an agent can verify the compare against the per-run machine views).
 */
export function compareFactsJson(
  composition: CompareComposition,
): Readonly<Record<string, unknown>> {
  return {
    source: {
      records: [
        "GET /executions/:id",
        "GET /executions/:id/results",
        "GET /executions/:id/events",
        "GET /executions/:id/verification",
      ],
      note: "Composed public records for the two selected runs, verbatim — no console-derived facts are added; the compare computes no score, aggregate or winner.",
    },
    selection: composition.selection,
    sameFamily: composition.sameFamily,
    genericAxesOnly: composition.genericAxesOnly,
    families: composition.families,
    facts: {
      a: explorerFactsOf(composition.facts.a),
      b: explorerFactsOf(composition.facts.b),
    },
    compare: {
      runs: { a: composition.sides.a, b: composition.sides.b },
      taskDelta: composition.taskDelta,
    },
    boundaries: composition.boundaries,
    authority: {
      note: "Compare is a projection over execution records — never a second comparator, benchmark or evaluation authority. The validation program's comparator harness (benchmarks/validation) is the established comparison machinery; this surface projects the same per-run public records into the playground console.",
    },
  };
}

// ---------------------------------------------------------------------------
// The HTML views (every interpolation escaped — the house rule)
// ---------------------------------------------------------------------------

const RECENTS_NOTE =
  "recently opened in this browser — navigation only; every view reads live through the governed API";

/** The compare-selection link for one execution row (the explorer + playground rows). */
export function compareLinkOf(executionId: string): string {
  return `/console/compare?a=${encodeURIComponent(executionId)}`;
}

function familyBanner(composition: CompareComposition): string {
  return composition.sameFamily
    ? `<p class="muted">Two runs of the <strong>${esc(
        composition.families.a,
      )}</strong> workload family, compared on every public fact — side by side, with the platform's own recorded planning explanation for each route. The console projects the records; it never scores, aggregates or picks a winner.</p>`
    : `<div class="state state-unavailable">
  <p class="state-title">Different workload families — generic axes only</p>
  <p class="state-body">Run a is of family "${esc(
    composition.families.a,
  )}" and run b of family "${esc(
    composition.families.b,
  )}". Runs of different families compare only on the generic axes (status, cost, usage, route, verification, duration); the composed task shapes are not comparable across families and are not rendered side by side.</p>
</div>`;
}

function sideHeaderCell(label: string, side: CompareSideFact): string {
  const lineage = [
    side.lineage.origin === null ? null : `origin ${side.lineage.origin}`,
    side.lineage.composed === null ? null : `composed ${side.lineage.composed}`,
    side.lineage.baseline === null
      ? null
      : `baseline lineage ${side.lineage.baseline}${
          side.lineage.baselineOf === null ? "" : ` (of ${side.lineage.baselineOf})`
        }`,
  ].filter((entry): entry is string => entry !== null);
  return `<th scope="col">${esc(label)} — <a href="/console/executions/${encodeURIComponent(
    side.executionId,
  )}">${esc(side.executionId)}</a><br><span class="muted">${esc(
    lineage.length === 0 ? "no lineage metadata recorded" : lineage.join(" · "),
  )}</span></th>`;
}

function costCell(side: CompareSideFact): string {
  return side.costMicroUsd === null
    ? '<span class="muted">not settled yet</span>'
    : `${esc(formatMicroUsd(side.costMicroUsd))} <span class="muted">(${esc(
        side.costMicroUsd,
      )} micro-USD${side.currency === null ? "" : `, ${esc(side.currency)}`})</span>`;
}

function usageCell(side: CompareSideFact): string {
  return side.inputTokens === null || side.outputTokens === null
    ? '<span class="muted">not recorded</span>'
    : `${esc(side.inputTokens)} in / ${esc(side.outputTokens)} out tokens`;
}

function routeCell(side: CompareSideFact): string {
  if (side.strategyClass === null && side.provider === null) {
    return '<span class="muted">no route recorded</span>';
  }
  const parts = [
    side.strategyClass === null ? "(class unrecorded)" : side.strategyClass,
    side.provider === null ? null : `via ${side.provider}`,
    side.model === null ? null : `model ${side.model}`,
    side.modelCalls === null ? null : `${side.modelCalls} model call(s)`,
  ].filter((entry): entry is string => entry !== null);
  return esc(parts.join(" · "));
}

function verificationCell(side: CompareSideFact): string {
  if (side.verification.total === 0) {
    return '<span class="muted">no checks recorded</span>';
  }
  return `${esc(String(side.verification.pass))} pass / ${esc(
    String(side.verification.fail),
  )} fail / ${esc(String(side.verification.inconclusive))} inconclusive <span class="muted">(${esc(
    String(side.verification.total),
  )} check(s))</span>`;
}

function durationCell(side: CompareSideFact): string {
  return side.durationMs === null
    ? '<span class="muted">not terminal yet</span>'
    : `${esc(formatDuration(side.durationMs))} <span class="muted">(${esc(
        String(side.durationMs),
      )} ms, derived from the recorded timestamps)</span>`;
}

function artifactsCell(side: CompareSideFact): string {
  if (side.artifactCount === 0) {
    return '<span class="muted">none recorded</span>';
  }
  const refs = side.artifactReferences
    .map(
      (artifact) =>
        `<a href="/assets/artifacts/${encodeURIComponent(artifact.id)}?executionId=${encodeURIComponent(
          side.executionId,
        )}">${esc(artifact.id)}</a>${
          artifact.digest === null
            ? ' <span class="muted">(no digest recorded)</span>'
            : ` <span class="muted mono">${esc(artifact.digest)}</span>`
        }`,
    )
    .join("<br>");
  return refs;
}

/** The side-by-side table — every fact from the public records. */
function compareSideBySideTable(composition: CompareComposition): string {
  const { a, b } = composition.sides;
  const row = (axis: string, cellA: string, cellB: string): string =>
    `<tr><th scope="row">${esc(axis)}</th><td>${cellA}</td><td>${cellB}</td></tr>`;
  return `<table class="data">
  <thead><tr><th scope="col">Axis</th>${sideHeaderCell("Run a", a)}${sideHeaderCell(
    "Run b",
    b,
  )}</tr></thead>
  <tbody>
  ${row("status", statusBadge(a.status), statusBadge(b.status))}
  ${row(
    "terminal outcome",
    a.terminalAt === null ? '<span class="muted">not terminal yet</span>' : esc(a.terminalAt),
    b.terminalAt === null ? '<span class="muted">not terminal yet</span>' : esc(b.terminalAt),
  )}
  ${row("duration", durationCell(a), durationCell(b))}
  ${row("recorded cost", costCell(a), costCell(b))}
  ${row("recorded usage", usageCell(a), usageCell(b))}
  ${row("recorded route", routeCell(a), routeCell(b))}
  ${row("verification outcomes", verificationCell(a), verificationCell(b))}
  ${row(
    "warnings",
    a.warningsCount === 0 ? "none" : esc(String(a.warningsCount)),
    b.warningsCount === 0 ? "none" : esc(String(b.warningsCount)),
  )}
  ${row("output artifacts (references + digests)", artifactsCell(a), artifactsCell(b))}
  ${row("workload family", esc(a.family), esc(b.family))}
  </tbody>
</table>`;
}

/** The composed-task delta (same family only; the honest note otherwise). */
function compareTaskDeltaView(composition: CompareComposition): string {
  if (!composition.taskDelta.comparable) {
    return `<p class="muted">${esc(composition.taskDelta.note)}</p>`;
  }
  const rows = composition.taskDelta.fields
    .map(
      (field) => `<tr>
      <th scope="row" class="mono">${esc(field.key)}</th>
      <td class="mono">${esc(field.a)}</td>
      <td class="mono">${esc(field.b)}</td>
      <td>${field.equal ? "same" : '<span class="muted">differs</span>'}</td>
    </tr>`,
    )
    .join("\n  ");
  const table =
    composition.taskDelta.fields.length === 0
      ? '<p class="muted">Neither run\'s record carries task fields.</p>'
      : `<table class="data">
  <thead><tr><th scope="col">Task field</th><th scope="col">Run a</th><th scope="col">Run b</th><th scope="col">Compare</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  return `<p class="muted">${esc(composition.taskDelta.note)}</p>
${table}`;
}

/** The explanation panel: the platform's OWN recorded planning rationale, verbatim. */
function compareExplanationPanel(side: CompareSideFact): string {
  const decision = side.planningDecision;
  if (decision === null) {
    return emptyState(
      "No planning decision recorded",
      `This run's public event stream carries no planning.decision-recorded envelope — the recorded explanation renders here when the platform journals it (GET /executions/:id/events).`,
    );
  }
  const candidates =
    decision.candidates.length === 0
      ? '<p class="muted">The recorded decision carries no candidate strategies.</p>'
      : `<table class="data">
  <thead><tr><th scope="col">Candidate strategy</th><th scope="col">Expected cost</th><th scope="col">Expected quality</th><th scope="col">Expected latency</th><th scope="col">Model calls</th><th scope="col">Admissible</th><th scope="col">Route rationale (recorded)</th></tr></thead>
  <tbody>${decision.candidates
    .map(
      (candidate) => `<tr>
      <td class="mono">${esc(candidate.strategyId)}${
        candidate.strategyId === decision.selectedStrategyId
          ? ' <span class="muted">(selected)</span>'
          : ""
      }</td>
      <td class="mono">${
        candidate.expectedCostMicroUsd === null
          ? "—"
          : `${esc(candidate.expectedCostMicroUsd)} micro-USD`
      }</td>
      <td>${candidate.expectedQuality === null ? "—" : esc(candidate.expectedQuality)}</td>
      <td>${candidate.expectedLatencyMs === null ? "—" : `${esc(candidate.expectedLatencyMs)} ms`}</td>
      <td>${candidate.modelCalls === null ? "—" : esc(candidate.modelCalls)}</td>
      <td>${
        candidate.admissible
          ? "yes"
          : `no${candidate.inadmissibleReason === null ? "" : ` (${esc(candidate.inadmissibleReason)})`}`
      }</td>
      <td class="mono">${esc(candidate.routeRationaleCode ?? "—")}${
        candidate.routeRationaleDetail === null
          ? ""
          : ` <span class="muted">${esc(candidate.routeRationaleDetail)}</span>`
      }</td>
    </tr>`,
    )
    .join("\n  ")}</tbody>
</table>`;
  const substrate =
    decision.substrate === null
      ? '<p class="muted">The recorded decision carries no substrate selection.</p>'
      : keyValueTable([
          ["substrate outcome", decision.substrate.outcome ?? "—"],
          ["workload class", decision.substrate.workloadClass ?? "—"],
          ["selected substrate", decision.substrate.selectedSubstrateId ?? "(none selected)"],
          ["substrate version", decision.substrate.selectedVersion ?? "—"],
          ["substrate rationale", decision.substrate.rationale ?? "—"],
        ]);
  return `${keyValueTable([
    ["decision id", decision.decisionId ?? "—"],
    ["planner version", decision.plannerVersion ?? "—"],
    ["recorded at", decision.occurredAt],
    ["selected strategy", decision.selectedStrategyId ?? "—"],
    ["deterministic-sufficiency outcome", decision.sufficiencyOutcome ?? "—"],
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
    ["risk level (task profile)", decision.riskLevel ?? "—"],
    [
      "quality target (task profile)",
      decision.qualityTarget === null ? "—" : String(decision.qualityTarget),
    ],
    ["policy outcome", decision.policyOutcome ?? "—"],
    [
      "capabilities satisfied",
      decision.capabilitySatisfied === null ? "—" : String(decision.capabilitySatisfied),
    ],
  ])}
${
  decision.selectionRationale === null
    ? '<p class="muted">The recorded decision carries no selection rationale.</p>'
    : `<blockquote class="muted">${esc(decision.selectionRationale)}</blockquote>`
}
<h4>Candidate strategies the planner considered (verbatim)</h4>
${candidates}
<h4>Compute substrate selection (verbatim)</h4>
${substrate}`;
}

/** The baseline launcher's consequence card for one side. */
function compareBaselineLauncherCard(
  composition: CompareComposition,
  side: CompareSideFact,
  idempotencyKey: string,
  sideLabel: string,
): string {
  return confirmationCard({
    title: `Re-run run ${sideLabel}'s composed task with baseline lineage?`,
    consequence: `The launcher re-submits run ${sideLabel}'s RECORDED composed task (the task, scope and constraints below crossed back verbatim from its public record, with the cost and latency ceilings capped at the playground sandbox limits) through the SAME frozen public create contract, carrying the baseline lineage metadata the platform records (metadata.baseline = ${COMPARE_BASELINE_LINEAGE}, metadata.baselineOf = the source run). The platform plans this new run under its own governed strategy selection — exactly as it planned the source run: no provider, model, rail, connection or agent is selected (selection is forbidden in the frozen contract), and policy admission is decided platform-side at dispatch.`,
    affected: `A NEW governed execution in the source run's own application scope (${side.applicationId}) — a separate row with its own identity, its own event ledger and its own settled cost; the source run is never mutated.`,
    cost: `Spend ceiling capped at $${PLAYGROUND_BUDGET_LIMIT_DOLLARS} and latency ceiling at ${String(
      PLAYGROUND_LATENCY_LIMIT_MS / 1000,
    )} seconds (the playground sandbox limits) — never above the source run's recorded constraints. No pre-run estimate exists; the settled cost is recorded per execution.`,
    whyAllowed:
      "The create request is valid against the frozen create contract — it selects no provider, model, rail, connection or agent, and it widens no vocabulary: the baseline request is the same create shape the playground composer emits, plus the lineage metadata the platform records. Baseline PLANNING semantics do not exist in the public contract; the honest boundary is named below and the missing contract is recorded for the Lead.",
    reversible: false,
    reversibleDetail:
      "No — a committed execution cannot be undone through the public contract. The governed stop is Cancel (its own consequence preview); work already performed and its evidence stay recorded and inspectable.",
    approvalNote:
      "No user pre-approval is part of the public create contract — the platform's policy admission at dispatch is the authorization boundary.",
    idempotencyNote: `The idempotency key ${idempotencyKey} is carried: resubmitting the same request converges on ONE execution rather than creating duplicates.`,
    hiddenFields: [
      ["executionId", side.executionId],
      ["idempotencyKey", idempotencyKey],
    ],
    confirmAction: "/console/compare/baseline",
    confirmLabel: `Re-run run ${sideLabel}'s task with baseline lineage`,
    cancelHref: `/console/compare?a=${encodeURIComponent(
      composition.selection.a,
    )}&b=${encodeURIComponent(composition.selection.b)}`,
  });
}

/** The full compare view (renders FROM the composition — no second source). */
export function compareView(composition: CompareComposition): string {
  const { a, b } = composition.sides;
  const boundaryRows = composition.boundaries
    .map(
      (boundary) => `<tr>
      <td class="mono">${esc(boundary.field)}</td>
      <td>${esc(boundary.statement)}${
        boundary.missingContract === undefined
          ? ""
          : ` <span class="muted">(missing contract: ${esc(boundary.missingContract)})</span>`
      }</td>
    </tr>`,
    )
    .join("\n  ");
  return `<p class="muted">Two runs of the same composed workload, compared through the public records — status, terminal outcome, recorded cost and usage, route summary, verification outcomes and duration, side by side. Below, the platform's OWN recorded planning explanation for each route: why the planner selected the strategy it did, from the planning decision's own journaled facts (sufficiency outcome, candidates with their expected cost/quality/latency trade-offs, selection rationale, substrate selection) — rendered verbatim, never re-derived console-side.</p>
${familyBanner(composition)}
<h2>Side-by-side — the public facts</h2>
${compareSideBySideTable(composition)}
<h2>The composed task (the recorded values)</h2>
${compareTaskDeltaView(composition)}
<h2>Why the platform planned each route — the recorded explanation</h2>
<p class="muted">The planning decision's own facts, exactly as the event ledger carries them (planning.decision-recorded). The console never re-derives, scores or classifies a strategy.</p>
<h3>Run a — <a href="/console/executions/${encodeURIComponent(a.executionId)}">${esc(
    a.executionId,
  )}</a></h3>
${compareExplanationPanel(a)}
<h3>Run b — <a href="/console/executions/${encodeURIComponent(b.executionId)}">${esc(
    b.executionId,
  )}</a></h3>
${compareExplanationPanel(b)}
<h2>Baseline launcher (the same composed task, re-run with baseline lineage)</h2>
${baselineSemanticsBoundaryView()}
${compareBaselineLauncherCard(composition, a, `dash-${globalThis.crypto.randomUUID()}`, "a")}
${compareBaselineLauncherCard(composition, b, `dash-${globalThis.crypto.randomUUID()}`, "b")}
<h2>Honest boundaries</h2>
<table class="data">
  <thead><tr><th scope="col">Field</th><th scope="col">Boundary</th></tr></thead>
  <tbody>${boundaryRows}</tbody>
</table>
<p class="muted">Machine parity: the same composed facts are served as verbatim JSON at <span class="mono">/console/compare/facts.json?a=${encodeURIComponent(
    composition.selection.a,
  )}&amp;b=${encodeURIComponent(
    composition.selection.b,
  )}</span> — each run's embedded facts are exactly what <span class="mono">/console/executions/&lt;id&gt;/facts.json</span> serves for that run. Compare is a projection over execution records, never a second comparator authority: the validation program's comparator harness (benchmarks/validation) is the established comparison machinery.</p>`;
}

// ---------------------------------------------------------------------------
// The selection views (pick one run, then the other)
// ---------------------------------------------------------------------------

/** The pick list of the browser's recents, one compare link per row. */
export function comparePickerView(
  pinned: ExplorerFacts | null,
  runs: readonly ExplorerRunFact[],
): string {
  const pinnedFamily = pinned === null ? null : explorerFamilyOf(pinned.execution);
  const pinnedId = pinned?.execution.id ?? null;
  const intro =
    pinned === null
      ? `<p class="muted">Select two runs of the same composed workload to compare — the run history the playground records plus the execution explorer's records, both sourced from this browser's disclosed recents (every row re-read live through the governed API). Pick the first run below; the compare view opens when the second is selected.</p>`
      : `<p class="muted">Run a is pinned: <a href="/console/executions/${encodeURIComponent(
          pinnedId ?? "",
        )}">${esc(pinnedId ?? "")}</a> (family <strong>${esc(
          pinnedFamily ?? "unrecorded",
        )}</strong>). Pick the second run below — same-family rows are marked; different-family runs compare on the generic axes only. <a href="/console/compare">Start over</a>.</p>`;
  if (runs.length === 0) {
    return `${intro}
${emptyState(
  "No executions opened in this browser yet",
  "Run one from the playground, the validation lab, or the quickstart — executions you open appear here for comparison.",
  RECENTS_NOTE,
)}`;
  }
  const rows = runs
    .map((run) => {
      const isPinned = run.id === pinnedId;
      const sameFamily = pinnedFamily !== null && run.family === pinnedFamily;
      // First pick pins run a (the picker then opens the compare on the
      // second pick); the link NEVER selects the same run twice.
      const href =
        pinnedId === null
          ? `/console/compare?a=${encodeURIComponent(run.id)}`
          : `/console/compare?a=${encodeURIComponent(pinnedId)}&b=${encodeURIComponent(run.id)}`;
      const marker = isPinned
        ? '<span class="muted">(pinned as run a)</span>'
        : sameFamily
          ? '<span class="muted">(same family)</span>'
          : '<span class="muted">(different family — generic axes only)</span>';
      const cell = isPinned ? marker : `<a href="${esc(href)}">Compare with this run</a> ${marker}`;
      return `<tr>
      <td><a class="mono" href="/console/executions/${encodeURIComponent(run.id)}">${esc(run.id)}</a></td>
      <td>${statusBadge(run.status)}</td>
      <td>${esc(run.family)}</td>
      <td class="mono">${esc(run.createdAt)}</td>
      <td>${run.costMicroUsd === null ? "—" : `$${esc(formatMicroUsd(run.costMicroUsd))}`}</td>
      <td class="mono">${run.origin === null ? "—" : esc(run.origin)}</td>
      <td>${cell}</td>
    </tr>`;
    })
    .join("\n  ");
  return `${intro}
<table class="data">
  <thead><tr><th scope="col">Execution</th><th scope="col">Status</th><th scope="col">Workload family</th><th scope="col">Created</th><th scope="col">Recorded cost</th><th scope="col">Origin</th><th scope="col">Compare</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<p class="muted">${esc(RECENTS_NOTE)}.</p>`;
}

/** The honest state when both selections are the same run. */
export function compareSameRunView(executionId: string): string {
  return `<div class="state state-unavailable">
  <p class="state-title">Both selections are the same run</p>
  <p class="state-body">The compare view needs two DIFFERENT executions (a and b are both "${esc(
    executionId,
  )}"). Pick a second run below — a run compared with itself renders nothing the run's own explorer page does not already carry.</p>
</div>`;
}

/** The not-found honest state for an unknown/invisible execution. */
export function compareNotFoundView(executionId: string): string {
  return errorState(
    "This execution is not visible through the governed API",
    `No execution "${executionId}" was returned — it may belong to another application or not exist. The console can only compare executions the API authorizes for this token.`,
    "GET /executions/:id through the Zeck SDK client",
  );
}

// ---------------------------------------------------------------------------
// The baseline re-run request (frozen create contract + recorded facts)
// ---------------------------------------------------------------------------

function recordedMicroUsdOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    BigInt(value);
  } catch {
    return null;
  }
  return value;
}

/**
 * Build the baseline re-run's create request from the source run's
 * RECORDED public facts ONLY: the task crosses back verbatim, the scope is
 * the record's own, the constraints are the recorded ones CAPPED at the
 * playground sandbox limits (never above), and the metadata carries the
 * baseline lineage the platform records. The builder can emit ONLY the
 * frozen create vocabulary — provider selection is structurally impossible
 * (the same discipline as the playground composer's request builder).
 */
export function buildBaselineRerunRequest(source: ExplorerFacts): ExecutionRequest {
  const { execution } = source;
  const recorded = execution.constraints;
  const recordedCost = recorded === null ? null : recordedMicroUsdOrNull(recorded.maxCostMicroUsd);
  const recordedLatency =
    recorded !== null &&
    typeof recorded.maxLatencyMs === "number" &&
    Number.isFinite(recorded.maxLatencyMs)
      ? recorded.maxLatencyMs
      : null;
  const budgetMicroUsd =
    recordedCost !== null && BigInt(recordedCost) < BigInt(PLAYGROUND_BUDGET_LIMIT_MICRO_USD)
      ? recordedCost
      : PLAYGROUND_BUDGET_LIMIT_MICRO_USD;
  const latencyMs = Math.min(
    recordedLatency ?? PLAYGROUND_LATENCY_LIMIT_MS,
    PLAYGROUND_LATENCY_LIMIT_MS,
  );
  const recordedFamily = stringMetadata(execution.metadata, "family");
  const recordedComposed = stringMetadata(execution.metadata, "composed");
  return {
    applicationId: execution.applicationId,
    ...(execution.environmentId === null ? {} : { environmentId: execution.environmentId }),
    task: execution.task,
    constraints: {
      maxCostMicroUsd: budgetMicroUsd,
      maxLatencyMs: latencyMs,
    },
    metadata: {
      origin: PLAYGROUND_ORIGIN,
      family: recordedFamily ?? explorerFamilyOf(execution),
      sandbox: "disposable",
      ...(recordedComposed === null ? {} : { composed: recordedComposed }),
      baseline: COMPARE_BASELINE_LINEAGE,
      baselineOf: execution.id,
    },
  };
}

// ---------------------------------------------------------------------------
// The route handlers (the composition seams pages.ts wires)
// ---------------------------------------------------------------------------

function compareShell(
  input: Omit<Parameters<typeof appShell>[0], "appearance" | "mode">,
  ctx: HttpContext,
): HandlerResult {
  const appearance: Appearance =
    ctx.cookies[APPEARANCE_COOKIE] === "light" || ctx.cookies[APPEARANCE_COOKIE] === "dark"
      ? ctx.cookies[APPEARANCE_COOKIE]
      : "system";
  return htmlResult(
    appShell({
      ...input,
      appearance,
      mode: modeOf(ctx.cookies),
      returnTo: ctx.path,
    }),
  );
}

function recentsCookieHeader(ids: readonly string[]): string {
  return serializeCookie(RECENTS_COOKIE, serializeRecents(ids), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

interface CompareRecentsView {
  readonly runs: readonly ExplorerRunFact[];
  readonly executions: readonly Execution[];
  readonly survivingIds: readonly string[];
  readonly pruned: boolean;
}

/** Live re-read of the browser's recents into compare picker rows (prune-on-404). */
async function readCompareRecents(
  client: ZeckClient,
  cookies: Readonly<Record<string, string>>,
): Promise<CompareRecentsView> {
  const ids = parseRecents(cookies[RECENTS_COOKIE]);
  const executionReads = await Promise.all(
    ids.map(async (id) => {
      try {
        return await client.getExecution(id);
      } catch (error) {
        if (error instanceof ZeckApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    }),
  );
  const executions = executionReads.filter(
    (execution): execution is Execution => execution !== null,
  );
  const survivingIds = executions.map((execution) => execution.id);
  const results = await Promise.all(
    survivingIds.map(async (id) => {
      try {
        return await client.getResult(id);
      } catch (error) {
        if (error instanceof ZeckApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    }),
  );
  const resultsById = new Map<string, ExecutionResult>();
  survivingIds.forEach((id, index) => {
    const result = results[index];
    if (result !== null && result !== undefined) {
      resultsById.set(id, result);
    }
  });
  return {
    runs: explorerRunsOf(executions, resultsById),
    executions,
    survivingIds,
    pruned: executions.length !== ids.length,
  };
}

function notFoundPage(executionId: string, ctx: HttpContext): HandlerResult {
  const content = `${pageHead({ title: "Execution not found", path: "/console/executions" })}
${compareNotFoundView(executionId)}
<p><a href="/console/compare">Back to run selection</a> · <a href="/console/executions">Open the execution explorer</a></p>`;
  return htmlStatusResult(
    404,
    appShell({
      title: "Zeck — Execution not found",
      activePath: "/console/executions",
      mainContent: content,
      appearance:
        ctx.cookies[APPEARANCE_COOKIE] === "light" || ctx.cookies[APPEARANCE_COOKIE] === "dark"
          ? ctx.cookies[APPEARANCE_COOKIE]
          : "system",
      mode: modeOf(ctx.cookies),
      returnTo: ctx.path,
    }),
  );
}

/**
 * GET /console/compare — the compare console page (DEP-031): the selection
 * views (pick one run, then the other) and, with ?a=&b= both present and
 * distinct, the side-by-side compare view rendered FROM the one
 * composition.
 */
export async function compareConsolePage(
  client: ZeckClient,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const a = (ctx.query.get("a") ?? "").trim();
  const b = (ctx.query.get("b") ?? "").trim();
  const head = pageHead({
    title: "Compare runs",
    path: "/console/executions",
    currentLabel: "Compare",
    primaryActionHtml: '<a class="button-link" href="/console/executions">Open the explorer</a>',
  });
  if (a.length === 0 && b.length === 0) {
    const recents = await readCompareRecents(client, ctx.cookies);
    const content = `${head}
${comparePickerView(null, recents.runs)}
${unavailableState(
  "No application-scoped execution listing exists in the public API",
  "The pick list is this browser's disclosed recents — each row is re-read live through GET /executions/:id. When a listing route ships, this page projects it.",
  "GET /executions (listing)",
)}`;
    const shell = compareShell(
      {
        title: "Zeck — Compare runs",
        activePath: "/console/executions",
        mainContent: content,
      },
      ctx,
    );
    return recents.pruned
      ? { ...shell, setCookies: [recentsCookieHeader(recents.survivingIds)] }
      : shell;
  }
  if (a.length > 0 && b.length === 0) {
    const pinned = await readCompareFacts(client, a);
    if (pinned === null) {
      return notFoundPage(a, ctx);
    }
    const recents = await readCompareRecents(client, ctx.cookies);
    const content = `${head}
${comparePickerView(pinned, recents.runs)}`;
    const shell = compareShell(
      {
        title: "Zeck — Compare runs",
        activePath: "/console/executions",
        mainContent: content,
      },
      ctx,
    );
    return recents.pruned
      ? { ...shell, setCookies: [recentsCookieHeader(recents.survivingIds)] }
      : shell;
  }
  if (b.length > 0 && a.length === 0) {
    const pinned = await readCompareFacts(client, b);
    if (pinned === null) {
      return notFoundPage(b, ctx);
    }
    const recents = await readCompareRecents(client, ctx.cookies);
    const content = `${head}
${comparePickerView(pinned, recents.runs)}`;
    const shell = compareShell(
      {
        title: "Zeck — Compare runs",
        activePath: "/console/executions",
        mainContent: content,
      },
      ctx,
    );
    return recents.pruned
      ? { ...shell, setCookies: [recentsCookieHeader(recents.survivingIds)] }
      : shell;
  }
  if (a === b) {
    const recents = await readCompareRecents(client, ctx.cookies);
    const content = `${head}
${compareSameRunView(a)}
${comparePickerView(null, recents.runs)}`;
    const shell = compareShell(
      {
        title: "Zeck — Compare runs",
        activePath: "/console/executions",
        mainContent: content,
      },
      ctx,
    );
    return recents.pruned
      ? { ...shell, setCookies: [recentsCookieHeader(recents.survivingIds)] }
      : shell;
  }
  const [factsA, factsB] = await Promise.all([
    readCompareFacts(client, a),
    readCompareFacts(client, b),
  ]);
  if (factsA === null) {
    return notFoundPage(a, ctx);
  }
  if (factsB === null) {
    return notFoundPage(b, ctx);
  }
  const composition = composeCompare(factsA, factsB);
  const content = `${head}
${compareView(composition)}`;
  // Opening the compare makes both runs recent (the explorer's own
  // open-adds-recents discipline — navigation only, never facts).
  const updatedRecents = addRecent(
    addRecent(parseRecents(ctx.cookies[RECENTS_COOKIE]), factsA.execution.id),
    factsB.execution.id,
  );
  const shell = compareShell(
    {
      title: "Zeck — Compare runs",
      activePath: "/console/executions",
      mainContent: content,
    },
    ctx,
  );
  return { ...shell, setCookies: [recentsCookieHeader(updatedRecents)] };
}

/**
 * GET /console/compare/facts.json — the machine twin (the SAME composition
 * as the HTML view, verbatim; no UI-only state). Both ?a= and ?b= are
 * required and must differ; unknown ids answer the honest JSON 404.
 */
export async function compareFactsRoute(
  client: ZeckClient,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const badRequest = (message: string): HandlerResult => ({
    status: 400,
    body: JSON.stringify({ error: "BAD_REQUEST", message }, null, 2),
    contentType: "application/json",
  });
  const a = (ctx.query.get("a") ?? "").trim();
  const b = (ctx.query.get("b") ?? "").trim();
  if (a.length === 0 || b.length === 0) {
    return badRequest(
      "The machine compare view needs both ?a= and ?b= execution ids — discover run ids through GET /console/executions/facts.json (the browser's disclosed recents) or the execution records themselves.",
    );
  }
  if (a === b) {
    return badRequest(
      "The compare view needs two DIFFERENT execution ids (a and b are the same run).",
    );
  }
  const [factsA, factsB] = await Promise.all([
    readCompareFacts(client, a),
    readCompareFacts(client, b),
  ]);
  if (factsA === null || factsB === null) {
    const missing = factsA === null ? a : b;
    return {
      status: 404,
      body: JSON.stringify(
        {
          error: "NOT_FOUND",
          message: `No execution "${missing}" is visible through the governed API for this token — there is nothing to compare.`,
        },
        null,
        2,
      ),
      contentType: "application/json",
    };
  }
  return {
    status: 200,
    body: JSON.stringify(compareFactsJson(composeCompare(factsA, factsB)), null, 2),
    contentType: "application/json",
  };
}

/** The concurrency gate view (the playground's own discipline, restated). */
function compareConcurrencyGateView(inFlight: number): string {
  return `<div class="state state-blocked">
  <p class="state-title">Sandbox concurrency limit reached</p>
  <p class="state-body">${inFlight} sandbox runs opened in this browser are still in flight (the limit is ${PLAYGROUND_MAX_CONCURRENT_RUNS}). The baseline launcher refuses to submit another until one finishes or is cancelled — uncontrolled spend and side effects are prevented by default, and this gate holds no server-side state: it is derived live from the runs this browser opened.</p>
  <p class="state-source">Open the active runs to wait or cancel: <a href="/runs/active">Active runs</a>.</p>
</div>`;
}

/**
 * POST /console/compare/baseline — the baseline launcher (DEP-031 AC3):
 * re-submit one run's RECORDED composed task through the frozen public
 * create contract with the baseline lineage metadata. Client-side
 * validation (before any wire call): the idempotency key and the source
 * execution id must be present, the source must be visible, and the
 * playground sandbox concurrency gate must hold.
 */
export async function compareBaselineLaunchHandler(
  client: ZeckClient,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const executionId = (ctx.form.executionId ?? "").trim();
  const idempotencyKey = (ctx.form.idempotencyKey ?? "").trim();
  const head = pageHead({
    title: "Baseline re-run",
    path: "/console/executions",
    currentLabel: "Compare",
    primaryActionHtml: `<a class="button-link" href="/console/compare?a=${encodeURIComponent(
      executionId,
    )}">Back to run selection</a>`,
  });
  const shellOf = (content: string): HandlerResult =>
    compareShell(
      {
        title: "Zeck — Baseline re-run",
        activePath: "/console/executions",
        mainContent: content,
      },
      ctx,
    );
  if (executionId.length === 0 || idempotencyKey.length === 0) {
    const content = `${head}
<div id="form-status" role="status" aria-live="polite" class="live-region">The baseline re-run could not be submitted — the form state was lost (the source execution id and the idempotency key are both required). Select the run again on the compare page.</div>
${errorState(
  "The baseline re-run form was incomplete",
  "Both the source execution id and a fresh idempotency key are required — resubmit from the compare page's baseline launcher, which carries both as hidden fields.",
  "POST /console/compare/baseline (executionId + idempotencyKey)",
)}`;
    return htmlStatusResult(422, shellOf(content).html ?? "");
  }
  const source = await readCompareFacts(client, executionId);
  if (source === null) {
    return notFoundPage(executionId, ctx);
  }
  const recents = await readCompareRecents(client, ctx.cookies);
  const inFlight = inFlightCount(recents.executions);
  if (inFlight >= PLAYGROUND_MAX_CONCURRENT_RUNS) {
    const content = `${head}
<div id="form-status" role="status" aria-live="polite" class="live-region">The sandbox concurrency limit refused this submission.</div>
${compareConcurrencyGateView(inFlight)}`;
    return htmlStatusResult(422, shellOf(content).html ?? "");
  }
  const request = buildBaselineRerunRequest(source);
  try {
    const { receipt } = await client.createExecution(request, idempotencyKey);
    return redirectResult(`/runs/${encodeURIComponent(receipt.executionId)}`);
  } catch (error) {
    if (error instanceof ZeckApiError && error.status < 500) {
      const content = `${head}
<div id="form-status" role="status" aria-live="polite" class="live-region">The platform rejected this baseline re-run: ${esc(
        error.body.message,
      )} (${esc(error.body.code)})</div>
${errorState(
  "The platform rejected the baseline re-run request",
  `The governed create route answered ${error.body.code}: ${error.body.message}. The rejection is surfaced, never silently retried — the request was valid against the frozen create contract, and policy admission is decided platform-side.`,
  "POST /executions through the Zeck SDK client",
)}
${baselineSemanticsBoundaryView()}`;
      return htmlStatusResult(422, shellOf(content).html ?? "");
    }
    throw error;
  }
}
