/**
 * Zeck usage, economics and optimization console module (DEP-030 — the
 * application-scoped usage projection over the public records).
 *
 * A PROJECTION, NEVER A SECOND AUTHORITY (DEP-030): this module holds NO
 * console-local budget, economics, ledger or optimization state. Every
 * fact it renders is read live from the public records the platform
 * already exposes:
 *
 *   - the execution record   `GET /executions/:id` (identity, status,
 *                            the declared per-run cost ceiling from
 *                            constraints, the recorded workload family);
 *   - the result record      `GET /executions/:id/results` (settled cost,
 *                            provider-reported token usage, the recorded
 *                            route summary — strategy class, provider,
 *                            model, model calls);
 *   - the event ledger       `GET /executions/:id/events` (the planning
 *                            decision records: selected strategy,
 *                            deterministic-first sufficiency outcome,
 *                            candidate strategies with their route
 *                            rationales, substrate selection — rendered
 *                            VERBATIM, never re-derived console-side);
 *   - the quota state        `GET /sandbox/quotas` (the budgets
 *                            authority's public per-dimension envelope:
 *                            limit, consumed, window, status).
 *
 * THE HONESTY DOCTRINE IS THE CORE OF THIS SURFACE: aggregates the public
 * API does not expose render as honest unavailable states NAMING the
 * missing contract — an application-scoped usage/aggregate route, the
 * budgets authority's reservation/settlement envelopes, real-time
 * consumption telemetry, aggregate optimization outcomes — never
 * approximated from console-local accumulation beyond the browser's own
 * disclosed recents (the same boundary every existing surface states).
 *
 * THE LIST: the public API exposes NO application-scoped execution
 * listing route — the per-run rows are this browser's disclosed recents,
 * each re-read live through the governed API (the explorer's DEP-012
 * discipline, restated on the surface).
 *
 * MACHINE PARITY (DEP-030 AC4): `usageFactsJson` composes the SAME facts
 * into the plain object served (verbatim JSON) under
 * `GET /console/usage/facts.json` — the HTML views and the machine view
 * cannot drift because both render from one composition.
 *
 * THE BUDGETS TRANSPORT: the sandbox governance routes require the
 * X-Zeck-Application scope selector as a HEADER on every request (the
 * single-sourced WORK-034 rule). This module owns its correctly-scoped
 * transport (the credentials.ts discipline — Bearer + the scope header on
 * every call); the deployment binding derives from the SAME environment
 * contract the dashboard entry point documents (ZECK_API_URL,
 * ZECK_TOKEN, ZECK_APPLICATION_ID). Absent bindings mean the console
 * honestly cannot reach the quota routes — null, never a fabricated
 * transport.
 */

import type { Execution, ExecutionEvent, ExecutionResult, ZeckClient } from "../../sdk";
import { ZeckApiError } from "../../sdk";
import { esc, formatMicroUsd, keyValueTable, statusBadge } from "./components";
import { explorerFamilyOf } from "./explorer";
import { type HandlerResult, type HttpContext, htmlResult, serializeCookie } from "./http";
import { modeOf } from "./modes";
import {
  APPEARANCE_COOKIE,
  declaredBudgetMicroUsd,
  type PlanningDecisionFact,
  parseRecents,
  planningDecisionOf,
  RECENTS_COOKIE,
  serializeRecents,
  sumMicroUsd,
} from "./projection";
import { type Appearance, appShell, pageHead } from "./shell";
import { emptyState, unavailableState } from "./states";

// ---------------------------------------------------------------------------
// The view vocabulary (three linkable views, the house tab-nav pattern)
// ---------------------------------------------------------------------------

export const USAGE_VIEWS = ["runs", "budgets", "optimization"] as const;

export type UsageView = (typeof USAGE_VIEWS)[number];

const VIEW_LABELS: Readonly<Record<UsageView, string>> = {
  runs: "Runs & cost",
  budgets: "Budgets & quotas",
  optimization: "Optimization",
};

export function usageViewOf(raw: string | null): UsageView {
  return USAGE_VIEWS.find((view) => view === raw) ?? "runs";
}

/** The tab nav over the three views (static paths; the house tabs pattern). */
export function usageTabNav(active: UsageView): string {
  const tab = (view: UsageView): string =>
    `<a class="tab${view === active ? " active" : ""}" href="/console/usage?tab=${view}"${
      view === active ? ' aria-current="page"' : ""
    }>${esc(VIEW_LABELS[view])}</a>`;
  return `<nav class="tabs" aria-label="Usage views">
  ${USAGE_VIEWS.map(tab).join("\n  ")}
</nav>`;
}

// ---------------------------------------------------------------------------
// The budgets transport (module-local over the public quota route; the
// credentials.ts discipline — the scope header on EVERY call)
// ---------------------------------------------------------------------------

/** One quota record as the public route serves it (the wire shape). */
export interface UsageQuotaFact {
  readonly id: string;
  readonly applicationId: string;
  readonly dimension: string;
  readonly limit: string;
  readonly consumed: string;
  readonly window: string;
  readonly status: string;
  readonly identityId: string | null;
  readonly updatedAt: string;
}

/** The quota-list response shape (the telemetry boundary included). */
export interface UsageQuotaListFact {
  readonly quotas: readonly UsageQuotaFact[];
  readonly telemetry: { readonly realtime: boolean };
}

/** The transport over the public quota route (injectable; env-derived). */
export interface UsageBudgetsTransport {
  listQuotas(): Promise<UsageQuotaListFact>;
}

/** A transport-level error carrying what the route honestly answered. */
export class UsageBudgetsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageBudgetsUnavailableError";
  }
}

export interface UsageBudgetsTransportOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly applicationId: string;
  readonly fetchImpl?: typeof fetch;
}

/** Build the transport over the public quota route (scope header always). */
export function createUsageBudgetsTransport(
  options: UsageBudgetsTransportOptions,
): UsageBudgetsTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async listQuotas(): Promise<UsageQuotaListFact> {
      const response = await fetchImpl(`${options.baseUrl}/sandbox/quotas`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${options.token}`,
          "x-zeck-application": options.applicationId,
        },
      });
      if (response.status === 404) {
        throw new UsageBudgetsUnavailableError(
          "the sandbox quota route is not present in this deployment",
        );
      }
      if (response.status === 422) {
        throw new UsageBudgetsUnavailableError(
          "the quota authority is not wired in this deployment (GET /sandbox/quotas answered the honest 422 — nothing is fabricated in its place)",
        );
      }
      if (!response.ok) {
        throw new UsageBudgetsUnavailableError(`GET /sandbox/quotas answered ${response.status}`);
      }
      return (await response.json()) as UsageQuotaListFact;
    },
  };
}

/**
 * The deployment-bound transport: derived from the console's environment
 * contract (the SAME variables the dashboard entry point documents).
 * Absent bindings mean the console honestly cannot reach the quota
 * routes — null, never a fabricated transport.
 */
export function usageBudgetsTransportFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: typeof fetch,
): UsageBudgetsTransport | null {
  const baseUrl = env.ZECK_API_URL;
  const token = env.ZECK_TOKEN;
  const applicationId = env.ZECK_APPLICATION_ID;
  if (
    typeof baseUrl !== "string" ||
    baseUrl.length === 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof applicationId !== "string" ||
    applicationId.length === 0
  ) {
    return null;
  }
  return createUsageBudgetsTransport({
    baseUrl,
    token,
    applicationId,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
}

/** The human display of a quota dimension (the platform's own vocabulary). */
export function usageQuotaDimensionLabel(dimension: string): string {
  switch (dimension) {
    case "spend-micro-usd":
      return "Spend (micro-USD)";
    case "wall-clock-ms":
      return "Wall-clock time (ms)";
    case "concurrent-runs":
      return "Concurrent runs";
    case "artifact-count":
      return "Artifact count";
    case "artifact-bytes":
      return "Artifact bytes";
    default:
      return dimension;
  }
}

/** The consumption/limit bar facts (progress in percent, 0..100). */
export function usageQuotaProgressOf(quota: UsageQuotaFact): number {
  const limit = Number(quota.limit);
  const consumed = Number(quota.consumed);
  if (!Number.isFinite(limit) || !Number.isFinite(consumed) || limit <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((consumed / limit) * 100));
}

// ---------------------------------------------------------------------------
// The composed facts (one composition drives the HTML AND the JSON view)
// ---------------------------------------------------------------------------

/** One run's usage facts, composed from the public records ONLY. */
export interface UsageRunFact {
  readonly executionId: string;
  /** The recorded workload family (the record's own metadata, never re-derived). */
  readonly family: string;
  readonly status: string;
  readonly createdAt: string;
  readonly terminalAt: string | null;
  /** Provider-reported input tokens, or null when the run has not settled. */
  readonly inputTokens: number | null;
  /** Provider-reported output tokens, or null when the run has not settled. */
  readonly outputTokens: number | null;
  /** The settled cost (integer micro-USD string), or null when not settled. */
  readonly costMicroUsd: string | null;
  /** The declared per-run ceiling (constraints.maxCostMicroUsd), or null. */
  readonly declaredLimitMicroUsd: string | null;
  /** The recorded route's provider (opaque string), or null. */
  readonly provider: string | null;
  /** The recorded route's strategy class (the platform's own vocabulary), or null. */
  readonly strategyClass: string | null;
  /** The recorded route's model-call count, or null. */
  readonly modelCalls: number | null;
}

/** One candidate strategy exactly as the recorded planning decision carries it. */
export interface UsageCandidateFact {
  readonly strategyId: string;
  readonly expectedCostMicroUsd: string | null;
  readonly expectedQuality: number | null;
  readonly admissible: boolean;
  /** The platform's own machine-readable route rationale code, or null. */
  readonly routeRationaleCode: string | null;
  readonly modelCalls: number | null;
}

/** One run's optimization facts — the platform's OWN recorded decisions. */
export interface UsageOptimizationFact {
  readonly executionId: string;
  readonly decisionId: string | null;
  readonly plannerVersion: string | null;
  readonly occurredAt: string | null;
  /** The strategy the platform's planner SELECTED (verbatim). */
  readonly selectedStrategyId: string | null;
  /** The planner's own recorded rationale for the selection (verbatim). */
  readonly selectionRationale: string | null;
  /** The recorded deterministic-sufficiency outcome (the platform's own vocabulary). */
  readonly sufficiencyOutcome: string | null;
  readonly semanticReasoningRequired: boolean | null;
  readonly deterministicQualityEstimate: number | null;
  /** Every candidate the decision carried, with its typed rationale (verbatim). */
  readonly candidates: readonly UsageCandidateFact[];
  /** The recorded substrate-selection outcome, or null. */
  readonly substrateOutcome: string | null;
  readonly workloadClass: string | null;
  /** The result record's own route summary (verbatim, never re-derived). */
  readonly strategyClass: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly routeModelCalls: number | null;
}

/** The quota axis of the composition (what the public route serves). */
export interface UsageBudgetsAxis {
  /** null ⇒ the transport is not bound in this deployment (honest state). */
  readonly quotas: readonly UsageQuotaFact[] | null;
  /** The telemetry boundary flag (meaningful only when quotas are present). */
  readonly realtime: boolean;
  /** true ⇒ the route answered an error (the honest error state renders). */
  readonly unavailableReason: string | null;
}

/** The whole composition — ONE object drives the HTML views AND facts.json. */
export interface UsageComposition {
  readonly runs: readonly UsageRunFact[];
  readonly optimization: readonly UsageOptimizationFact[];
  /** The DISCLOSED browser-scoped roll-up (recents only — never application scope). */
  readonly browserScoped: {
    readonly runCount: number;
    readonly settledCount: number;
    readonly totalCostMicroUsd: string;
  };
  readonly budgets: UsageBudgetsAxis;
}

/**
 * Compose one run's usage facts from the public records ONLY: cost/usage/
 * route from the result package, the declared ceiling from the execution
 * record's constraints, the family from the record's own metadata. A
 * missing fact stays null — never zero, never a guess (the honesty
 * doctrine; a null result package means the run has not settled).
 */
export function usageRunFactOf(execution: Execution, result: ExecutionResult | null): UsageRunFact {
  return {
    executionId: execution.id,
    family: explorerFamilyOf(execution),
    status: execution.status,
    createdAt: execution.createdAt,
    terminalAt: execution.terminalAt,
    inputTokens: result?.usage?.inputTokens ?? null,
    outputTokens: result?.usage?.outputTokens ?? null,
    costMicroUsd: result?.cost?.totalMicroUsd ?? null,
    declaredLimitMicroUsd: declaredBudgetMicroUsd(execution),
    provider: result?.route?.provider ?? null,
    strategyClass: result?.route?.strategyClass ?? null,
    modelCalls: result?.route?.modelCalls ?? null,
  };
}

/**
 * Compose one run's optimization facts VERBATIM from the recorded
 * planning decision (the event ledger's own `planning.decision-recorded`
 * envelope) and the result record's route summary. The console NEVER
 * re-derives, scores or classifies a strategy: every field is the
 * platform's own recorded vocabulary. A run whose stream carries no
 * planning decision renders the honest unrecorded state.
 */
export function usageOptimizationFactOf(
  execution: Execution,
  result: ExecutionResult | null,
  events: readonly ExecutionEvent[],
): UsageOptimizationFact {
  const decision: PlanningDecisionFact | null = planningDecisionOf(events);
  return {
    executionId: execution.id,
    decisionId: decision?.decisionId ?? null,
    plannerVersion: decision?.plannerVersion ?? null,
    occurredAt: decision?.occurredAt ?? null,
    selectedStrategyId: decision?.selectedStrategyId ?? null,
    selectionRationale: decision?.selectionRationale ?? null,
    sufficiencyOutcome: decision?.sufficiencyOutcome ?? null,
    semanticReasoningRequired: decision?.semanticReasoningRequired ?? null,
    deterministicQualityEstimate: decision?.deterministicQualityEstimate ?? null,
    candidates:
      decision?.candidates.map((candidate) => ({
        strategyId: candidate.strategyId,
        expectedCostMicroUsd: candidate.expectedCostMicroUsd,
        expectedQuality: candidate.expectedQuality,
        admissible: candidate.admissible,
        routeRationaleCode: candidate.routeRationaleCode,
        modelCalls: candidate.modelCalls,
      })) ?? [],
    substrateOutcome: decision?.substrate?.outcome ?? null,
    workloadClass: decision?.substrate?.workloadClass ?? null,
    strategyClass: result?.route?.strategyClass ?? null,
    provider: result?.route?.provider ?? null,
    model: result?.route?.model ?? null,
    routeModelCalls: result?.route?.modelCalls ?? null,
  };
}

/**
 * Compose the disclosed browser-scoped roll-up (the ONLY accumulation
 * this surface performs — over the browser's own disclosed recents, in
 * integer micro-USD, never presented as an application-scoped fact).
 */
export function usageBrowserScopedRollup(
  runs: readonly UsageRunFact[],
): UsageComposition["browserScoped"] {
  return {
    runCount: runs.length,
    settledCount: runs.filter((run) => run.costMicroUsd !== null).length,
    totalCostMicroUsd: sumMicroUsd(
      runs.map((run) => run.costMicroUsd).filter((value): value is string => value !== null),
    ),
  };
}

/**
 * The machine view served at GET /console/usage/facts.json — the SAME
 * composition as the HTML (parity by construction; no UI-only state).
 * The boundaries object names every aggregate the public API does NOT
 * expose, exactly as the HTML states them.
 */
export function usageFactsJson(composition: UsageComposition): Readonly<Record<string, unknown>> {
  return {
    source: {
      records: [
        "GET /executions/:id",
        "GET /executions/:id/results",
        "GET /executions/:id/events",
        "GET /sandbox/quotas",
      ],
      note: "Composed public records over this browser's disclosed recents, verbatim — no console-derived facts are added.",
    },
    runs: composition.runs,
    optimization: composition.optimization,
    browserScoped: composition.browserScoped,
    budgets: {
      quotas: composition.budgets.quotas,
      telemetry: { realtime: composition.budgets.realtime },
      ...(composition.budgets.unavailableReason === null
        ? {}
        : { unavailableReason: composition.budgets.unavailableReason }),
    },
    boundaries: {
      applicationScopedUsage: {
        available: false,
        missingContract:
          "an application-scoped usage/aggregate route (per-application totals over ALL runs) over the economics/budgets authorities",
      },
      budgetEnvelopes: {
        available: false,
        missingContract:
          "a budgets projection route over the budgets authority's reservation/settlement/envelope records (only the per-dimension quota state is public)",
      },
      realtimeConsumptionTelemetry: {
        available: false,
        missingContract: "a consumption-telemetry projection over GET /sandbox/quotas",
      },
      aggregateOptimizationOutcomes: {
        available: false,
        missingContract:
          "an application-scoped optimization-outcome route (aggregate strategy-class / cache-reuse outcome rates); per-run recorded decisions are the public facts",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The HTML views (each renders ONLY public-record facts)
// ---------------------------------------------------------------------------

const RECENTS_NOTE =
  "recently opened in this browser — navigation only; every view reads live through the governed API";

/** Runs & cost — the per-run cost/usage table + the honest aggregate boundary. */
export function usageRunsView(composition: UsageComposition): string {
  const { runs, browserScoped } = composition;
  const rows =
    runs.length === 0
      ? emptyState(
          "No usage yet",
          "No executions have been opened in this browser — per-run usage appears here as runs are opened. The public API exposes no application-scoped usage listing.",
        )
      : `<table class="data">
  <thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Family</th><th scope="col">Tokens in</th><th scope="col">Tokens out</th><th scope="col">Settled cost</th><th scope="col">Declared limit</th><th scope="col">Recorded route</th></tr></thead>
  <tbody>${runs
    .map(
      (run) => `<tr>
      <td><a href="/runs/${encodeURIComponent(run.executionId)}">${esc(run.executionId)}</a></td>
      <td>${statusBadge(run.status)}</td>
      <td>${esc(run.family)}</td>
      <td>${run.inputTokens === null ? '<span class="muted">not recorded</span>' : esc(run.inputTokens)}</td>
      <td>${run.outputTokens === null ? '<span class="muted">not recorded</span>' : esc(run.outputTokens)}</td>
      <td>${
        run.costMicroUsd === null
          ? '<span class="muted">not settled yet</span>'
          : `${esc(formatMicroUsd(run.costMicroUsd))} <span class="muted">(${esc(run.costMicroUsd)} micro-USD)</span>`
      }</td>
      <td>${
        run.declaredLimitMicroUsd === null
          ? '<span class="muted">none declared</span>'
          : `${esc(formatMicroUsd(run.declaredLimitMicroUsd))} <span class="muted">(${esc(run.declaredLimitMicroUsd)} micro-USD)</span>`
      }</td>
      <td>${
        run.strategyClass === null && run.provider === null
          ? '<span class="muted">no route recorded</span>'
          : `${esc(run.strategyClass ?? "(class unrecorded)")}${
              run.provider === null ? "" : ` <span class="muted">via ${esc(run.provider)}</span>`
            }`
      }</td>
    </tr>`,
    )
    .join("\n  ")}</tbody>
</table>`;
  const rollup =
    runs.length === 0
      ? ""
      : `<p class="muted">Browser-scoped disclosed roll-up (this browser's recents only, never an application-scoped fact): ${esc(
          String(browserScoped.runCount),
        )} run(s) opened, ${esc(String(browserScoped.settledCount))} settled, total settled cost ${esc(
          formatMicroUsd(browserScoped.totalCostMicroUsd),
        )} (${esc(browserScoped.totalCostMicroUsd)} micro-USD).</p>`;
  return `<h2>Runs &amp; cost</h2>
<p class="muted">Per-run usage for executions opened in this browser — provider-reported token usage, the settled cost and the declared per-run ceiling, exactly as the public records carry them (${esc(
    RECENTS_NOTE,
  )}).</p>
${rows}
${rollup}
${unavailableState(
  "Application-scoped usage aggregates",
  "The public API exposes no application-scoped usage or billing aggregate — totals over ALL of an application's runs (not just this browser's disclosed recents) are the economics/budgets authorities' own records and do not cross the public wire. Nothing here approximates them.",
  "an application-scoped usage/aggregate route (e.g. GET /applications/:id/usage) over the economics/budgets authorities",
)}
${unavailableState(
  "Per-step and per-model cost breakdown",
  "The public API exposes no per-step or per-model cost breakdown — only the settled per-run total (GET /executions/:id/results). This boundary renders honestly rather than approximating from non-public internals.",
  "a cost-breakdown projection over GET /executions/:id/results",
)}`;
}

/** Budgets & quotas — the budgets authority's public quota state + boundaries. */
export function usageBudgetsView(composition: UsageComposition): string {
  const { budgets } = composition;
  const quotaBlock =
    budgets.quotas === null
      ? budgets.unavailableReason === null
        ? unavailableState(
            "Sandbox budget and quota envelopes",
            "The budgets transport is not bound in this deployment (ZECK_API_URL / ZECK_TOKEN / ZECK_APPLICATION_ID) — the per-dimension quota envelopes render when the composition wires them. Nothing is fabricated in their place.",
            "GET /sandbox/quotas through the deployment's environment contract",
          )
        : unavailableState(
            "Sandbox budget and quota envelopes",
            budgets.unavailableReason,
            "GET /sandbox/quotas (the budgets authority's public quota state)",
          )
      : budgets.quotas.length === 0
        ? emptyState(
            "No quotas configured",
            "No sandbox quota records are visible to this scope — quotas appear here when the application configures them (per dimension: spend, wall-clock time, concurrent runs, artifact count/bytes).",
          )
        : `<table class="data">
  <thead><tr><th scope="col">Dimension</th><th scope="col">Consumed</th><th scope="col">Limit</th><th scope="col">Window</th><th scope="col">Status</th><th scope="col">Use</th></tr></thead>
  <tbody>${budgets.quotas
    .map(
      (quota) => `<tr>
      <td>${esc(usageQuotaDimensionLabel(quota.dimension))}</td>
      <td class="mono">${esc(quota.consumed)}</td>
      <td class="mono">${esc(quota.limit)}</td>
      <td>${esc(quota.window)}</td>
      <td>${esc(quota.status)}</td>
      <td>${usageQuotaProgressOf(quota)}%</td>
    </tr>`,
    )
    .join("\n  ")}</tbody>
</table>`;
  const declaredLimits =
    composition.runs.length === 0
      ? emptyState(
          "No declared per-run ceilings yet",
          "Per-run cost ceilings (constraints.maxCostMicroUsd on the create request) render here as runs are opened in this browser.",
        )
      : `<table class="data">
  <thead><tr><th scope="col">Run</th><th scope="col">Declared ceiling</th><th scope="col">Settled cost</th></tr></thead>
  <tbody>${composition.runs
    .map(
      (run) => `<tr>
      <td><a href="/runs/${encodeURIComponent(run.executionId)}">${esc(run.executionId)}</a></td>
      <td>${
        run.declaredLimitMicroUsd === null
          ? '<span class="muted">none declared</span>'
          : `${esc(formatMicroUsd(run.declaredLimitMicroUsd))} <span class="muted">(${esc(run.declaredLimitMicroUsd)} micro-USD)</span>`
      }</td>
      <td>${
        run.costMicroUsd === null
          ? '<span class="muted">not settled yet</span>'
          : `${esc(formatMicroUsd(run.costMicroUsd))}`
      }</td>
    </tr>`,
    )
    .join("\n  ")}</tbody>
</table>`;
  return `<h2>Budgets &amp; quotas</h2>
<p class="muted">The budgets authority's PUBLIC quota state for this application scope — per-dimension envelopes, consumption and windows, read live through the governed route. Reservations, settlements and wallet envelopes are the authority's own records and stay named as missing public contracts below.</p>
${quotaBlock}
${
  budgets.quotas !== null && !budgets.realtime
    ? unavailableState(
        "Real-time consumption telemetry",
        "Quota consumption updates on read — the public API exposes no real-time consumption stream.",
        "a consumption-telemetry projection over GET /sandbox/quotas",
      )
    : ""
}
<h3>Declared per-run ceilings (this browser's recents)</h3>
${declaredLimits}
${unavailableState(
  "Budget reservations and settlement envelopes",
  "The budgets authority's reservation/settlement lifecycle — holds placed before dispatch, exactly-once settlement, wallet envelopes and spend categories across ALL work — is module-internal and not exposed by the public API. Only the per-dimension quota state above is public; nothing on this surface competes with the authority's accounting.",
  "a budgets projection route over the budgets authority's reservation/settlement/envelope records",
)}`;
}

/** Optimization — the platform's OWN recorded planning decisions, verbatim. */
export function usageOptimizationView(composition: UsageComposition): string {
  const sections =
    composition.optimization.length === 0
      ? emptyState(
          "No optimization facts yet",
          "No executions have been opened in this browser — the platform's recorded planning decisions render here as runs are opened (GET /executions/:id/events → planning.decision-recorded).",
        )
      : composition.optimization
          .map((fact) => {
            const route =
              fact.strategyClass === null
                ? '<p class="muted">The result record carries no route summary (GET /executions/:id/results → route).</p>'
                : keyValueTable([
                    ["recorded strategy class", fact.strategyClass],
                    ["provider", fact.provider ?? "(deterministic — no provider call)"],
                    ["model", fact.model ?? "—"],
                    ["model calls", String(fact.routeModelCalls ?? 0)],
                  ]);
            const decision =
              fact.decisionId === null
                ? emptyState(
                    "No planning decision recorded",
                    "This run's public event stream carries no planning.decision-recorded envelope — the recorded decision renders here when the platform journals it (GET /executions/:id/events).",
                  )
                : keyValueTable([
                    ["decision id", fact.decisionId],
                    ["planner version", fact.plannerVersion ?? "—"],
                    ["selected strategy", fact.selectedStrategyId ?? "—"],
                    ["deterministic-sufficiency outcome", fact.sufficiencyOutcome ?? "—"],
                    [
                      "semantic reasoning required",
                      fact.semanticReasoningRequired === null
                        ? "—"
                        : fact.semanticReasoningRequired
                          ? "yes"
                          : "no",
                    ],
                    [
                      "deterministic quality estimate",
                      fact.deterministicQualityEstimate === null
                        ? "—"
                        : String(fact.deterministicQualityEstimate),
                    ],
                    ["substrate outcome", fact.substrateOutcome ?? "—"],
                    ["workload class", fact.workloadClass ?? "—"],
                  ]);
            const rationale =
              fact.selectionRationale === null
                ? ""
                : `<blockquote class="muted">${esc(fact.selectionRationale)}</blockquote>`;
            const candidates =
              fact.candidates.length === 0
                ? '<p class="muted">The recorded decision carries no candidate strategies.</p>'
                : `<table class="data">
  <thead><tr><th scope="col">Candidate strategy</th><th scope="col">Expected cost</th><th scope="col">Expected quality</th><th scope="col">Model calls</th><th scope="col">Admissible</th><th scope="col">Route rationale (recorded)</th></tr></thead>
  <tbody>${fact.candidates
    .map(
      (candidate) => `<tr>
      <td class="mono">${esc(candidate.strategyId)}${
        candidate.strategyId === fact.selectedStrategyId
          ? ' <span class="muted">(selected)</span>'
          : ""
      }</td>
      <td class="mono">${
        candidate.expectedCostMicroUsd === null
          ? "—"
          : `${esc(candidate.expectedCostMicroUsd)} micro-USD`
      }</td>
      <td>${candidate.expectedQuality === null ? "—" : esc(candidate.expectedQuality)}</td>
      <td>${candidate.modelCalls === null ? "—" : esc(candidate.modelCalls)}</td>
      <td>${candidate.admissible ? "yes" : '<span class="muted">no</span>'}</td>
      <td class="mono">${esc(candidate.routeRationaleCode ?? "—")}</td>
    </tr>`,
    )
    .join("\n  ")}</tbody>
</table>`;
            return `<section aria-labelledby="usage-opt-${esc(fact.executionId)}">
  <h3 id="usage-opt-${esc(fact.executionId)}"><a href="/runs/${encodeURIComponent(
    fact.executionId,
  )}">${esc(fact.executionId)}</a></h3>
  <h4>Route summary (the result record)</h4>
  ${route}
  <h4>Recorded planning decision (verbatim)</h4>
  ${decision}
  ${rationale}
  <h4>Candidate strategies the planner considered</h4>
  ${candidates}
</section>`;
          })
          .join("\n");
  return `<h2>Optimization</h2>
<p class="muted">The platform's OWN recorded optimization decisions per run — the selected strategy, the deterministic-first sufficiency outcome, every candidate with its typed route rationale (the platform's frozen vocabulary: deterministic-sufficient, cheap-first-cascade, …), and the recorded route summary. The console renders these VERBATIM from the event ledger and result records — it never re-derives, scores or classifies a strategy console-side.</p>
${sections}
${unavailableState(
  "Aggregate optimization outcomes",
  "Application-scoped optimization aggregates — strategy-class distributions, cache/reuse outcome rates, deterministic-first win rates over ALL runs — have no public route. The per-run recorded decisions above are the public facts; this boundary renders honestly rather than approximating an aggregate.",
  "an application-scoped optimization-outcome route over the planning/economics authorities",
)}`;
}

/** Render one view by id (the router's single dispatch point). */
export function usageView(view: UsageView, composition: UsageComposition): string {
  switch (view) {
    case "budgets":
      return usageBudgetsView(composition);
    case "optimization":
      return usageOptimizationView(composition);
    case "runs":
      return usageRunsView(composition);
  }
}

// ---------------------------------------------------------------------------
// The live composition (recents re-read + transport; one path for HTML+JSON)
// ---------------------------------------------------------------------------

interface UsageRecordsView {
  readonly composition: UsageComposition;
  readonly survivingIds: readonly string[];
  readonly pruned: boolean;
}

/**
 * Read the composition live: the browser's disclosed recents re-read
 * through the governed API (execution + result + events per run; a 404
 * result keeps the honest not-settled view, every other error propagates
 * fail-closed), plus the quota axis through the budgets transport (an
 * error renders the honest unavailable state, never a fabricated quota).
 */
export async function readUsageComposition(
  client: ZeckClient,
  budgets: UsageBudgetsTransport | null,
  cookies: Readonly<Record<string, string>>,
): Promise<UsageRecordsView> {
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
  const pruned = executions.length !== ids.length;
  const perRun = await Promise.all(
    executions.map(async (execution) => {
      const result = await client.getResult(execution.id).catch((error: unknown) => {
        if (error instanceof ZeckApiError && error.status === 404) {
          return null;
        }
        throw error;
      });
      const events = await client.listEvents(execution.id).catch((error: unknown) => {
        if (error instanceof ZeckApiError && error.status === 404) {
          return [] as readonly ExecutionEvent[];
        }
        throw error;
      });
      return { execution, result, events };
    }),
  );
  const runs = perRun.map(({ execution, result }) => usageRunFactOf(execution, result));
  const optimization = perRun.map(({ execution, result, events }) =>
    usageOptimizationFactOf(execution, result, events),
  );
  let quotaAxis: UsageBudgetsAxis = { quotas: null, realtime: false, unavailableReason: null };
  if (budgets !== null) {
    try {
      const quotaList = await budgets.listQuotas();
      quotaAxis = {
        quotas: quotaList.quotas,
        realtime: quotaList.telemetry.realtime,
        unavailableReason: null,
      };
    } catch (error) {
      quotaAxis = {
        quotas: null,
        realtime: false,
        unavailableReason:
          error instanceof UsageBudgetsUnavailableError
            ? error.message
            : "the quota route could not be read in this deployment",
      };
    }
  }
  return {
    composition: {
      runs,
      optimization,
      browserScoped: usageBrowserScopedRollup(runs),
      budgets: quotaAxis,
    },
    survivingIds: executions.map((execution) => execution.id),
    pruned,
  };
}

// ---------------------------------------------------------------------------
// The page + the machine route (the composition seams pages.ts wires)
// ---------------------------------------------------------------------------

function usageShell(
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

/**
 * GET /console/usage — the first-class Usage surface (DEP-030). The
 * budgets transport arrives per-request from the deployment's environment
 * contract (null ⇒ the honest unavailable states, never a fabricated
 * transport).
 */
export async function usageConsolePage(
  client: ZeckClient,
  budgets: UsageBudgetsTransport | null,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const view = usageViewOf(ctx.query.get("tab"));
  const records = await readUsageComposition(client, budgets, ctx.cookies);
  const setCookies = records.pruned ? [recentsCookieHeader(records.survivingIds)] : undefined;
  const content = `${pageHead({
    title: "Usage & economics",
    path: "/console/usage",
    primaryActionHtml:
      '<a class="button-link" href="/console/usage/facts.json">The composed facts as JSON</a>',
  })}
<p>What this application's runs spent, on which runs, under which budgets and quotas — and what the platform's optimizer decided, verbatim. Every fact is a live read through the governed public API; the per-run rows cover the executions opened in this browser (${esc(
    RECENTS_NOTE,
  )}). Aggregates the public API does not expose render as honest unavailable states naming the missing contract.</p>
${usageTabNav(view)}
${usageView(view, records.composition)}
<p class="muted">Machine parity: the same composed facts are served as verbatim JSON at <span class="mono">/console/usage/facts.json</span> — an agent reads the usage surface without scraping HTML. Per-run facts also link to the <a href="/console/executions">execution explorer</a> and the operator's <a href="/admin/budgets">Spend (Control)</a> surface.</p>`;
  const shell = usageShell(
    {
      title: "Zeck — Usage & economics",
      activePath: "/console/usage",
      mainContent: content,
    },
    ctx,
  );
  return { ...shell, ...(setCookies === undefined ? {} : { setCookies }) };
}

/**
 * GET /console/usage/facts.json — the machine twin (the SAME composition
 * as the HTML, verbatim; no UI-only state).
 */
export async function usageFactsRoute(
  client: ZeckClient,
  budgets: UsageBudgetsTransport | null,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const records = await readUsageComposition(client, budgets, ctx.cookies);
  return {
    status: 200,
    body: JSON.stringify(usageFactsJson(records.composition), null, 2),
    contentType: "application/json",
    ...(records.pruned ? { setCookies: [recentsCookieHeader(records.survivingIds)] } : {}),
  };
}
