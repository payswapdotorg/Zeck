/**
 * Zeck dashboard control-plane presentation (WORK-039).
 *
 * THE ONE control/improvement presentation vocabulary: every route that
 * renders a control or improvement fact — the Control surfaces (Policies,
 * Spend, Team, Environments, Audit), the Connections surface, the Improve
 * surfaces (Insights, Learning) and the blocked-run explanation — composes
 * THIS module, so the same semantic vocabulary (Rules/Controls, Spend/
 * Limit, the secret-mediated connection story, the never-authorizes
 * learning boundary) appears everywhere and nowhere else (Implementation
 * Requirements 1–3).
 *
 * The honesty rules (the WORK-039 checkpoint contracts):
 *  - policy remains the authorization boundary: the dashboard explains
 *    controls and denials in user language, never resolves effective
 *    policy itself — the recorded denial reason is the controlling rule,
 *    rendered verbatim (AC2);
 *  - accounting remains canonical: every money figure is a platform
 *    recording (integer micro-USD strings, BigInt sums only); the
 *    dashboard computes NO ledger, reservation or settlement truth —
 *    those are the accounting authority's, disclosed as advanced detail
 *    with their honest public absence (AC3);
 *  - credentials remain secret-mediated: the connection presentation
 *    renders the platform's own opaque routing strings only — there is
 *    no field on any public wire shape where a secret could even appear
 *    (AC4);
 *  - learning produces recommendations and evidence, never authorization:
 *    the Improve surfaces render the distinction (evidence /
 *    recommendation / authoritative production) with the live anchors on
 *    the platform's own records, and NO apply mutation exists anywhere
 *    on them (AC6/AC7, IR6);
 *  - every consequential path renders consequence and authorization
 *    BEFORE commitment through the WORK-035 confirmation primitive —
 *    this module never mutates anything itself (AC8).
 *
 * This module renders; the derivations live in projection.ts (pure
 * view-models over the public wire shapes only).
 */

import { distinctionList, esc, formatMicroUsd, glanceGrid, keyValueTable } from "./components";
import { advancedDisclosure } from "./disclosure";
import type {
  AgentSelectionFact,
  ApprovalQueueFact,
  EnvironmentFact,
  LearningAuthorityRow,
  PolicyDenialFact,
  ProviderCategoryFact,
  RecommendationDispositionRow,
  RunSpendFact,
} from "./projection";
import { learningAuthorityRows, recommendationDispositionRows } from "./projection";

// ---------------------------------------------------------------------------
// The control families (AC1 — user-level controls first)
// ---------------------------------------------------------------------------

/** The control families in user language (AC1's exact list, in order). */
export const CONTROL_FAMILY_LABELS: readonly string[] = [
  "Quality",
  "Spend",
  "Latency",
  "Data",
  "Tools",
  "Approvals",
  "Autonomy",
];

/**
 * The user-level control families (AC1): the three families the public
 * create contract carries LIVE (quality floor, spend limit, latency
 * limit — set per execution, enforced by policy admission) render first
 * with their live vocabulary; the four families no public vocabulary
 * carries yet render as their own explicit absences — never a fabricated
 * default. Rendered through the shared distinction list (IR1).
 */
export function controlFamiliesTable(): string {
  return distinctionList([
    {
      label: "Quality",
      fact: "A minimum quality target for a run — declared per execution on the create request (the quality floor the route must respect) and enforced platform-side at policy admission. Every run's recorded target appears on its review envelope and run page.",
      backed: true,
    },
    {
      label: "Spend",
      fact: "A spend limit for a run — declared per execution as an integer micro-USD constraint and enforced as the request's cost ceiling at policy admission. The live per-run limits and settled costs are on the Spend surface.",
      backed: true,
    },
    {
      label: "Latency",
      fact: "A maximum end-to-end latency for a run — declared per execution in whole seconds on the create request. The settled duration of every run is recorded on its header facts.",
      backed: true,
    },
    {
      label: "Data",
      fact: "Data handling controls — regions, retention, what work may read. The public API exposes no data-control vocabulary yet; data governance is decided by the effective policy platform-side. When the vocabulary ships, its effective values render here.",
      backed: false,
    },
    {
      label: "Tools",
      fact: "Which external tools and connections governed work may use. Tool admission is a policy decision at dispatch (never a dashboard-side selection — the create contract forbids selecting providers or connections); no public tool-control vocabulary exists yet.",
      backed: false,
    },
    {
      label: "Approvals",
      fact: "When external side effects require a human decision before they proceed — a policy decision. The live public record is per-run waiting states: a run that needs approval surfaces as WAITING_USER or WAITING_HUMAN with its own attention item; the Home surface carries the live queue.",
      backed: true,
    },
    {
      label: "Autonomy",
      fact: "How much self-direction governed work has — the effective policy's autonomy rules at dispatch. The public API exposes no autonomy vocabulary yet; autonomy is never implied by an agent's record (the agent projection carries no autonomy facts).",
      backed: false,
    },
  ]);
}

// ---------------------------------------------------------------------------
// The blocked explanation (AC2 — why an action is blocked, which rule)
// ---------------------------------------------------------------------------

/**
 * The blocked-run explanation (AC2): the platform-recorded denial reason
 * rendered VERBATIM as the controlling rule, the boundary sentence (policy
 * is the admission authority — the dashboard never re-resolves it), and
 * the honest composition note (the effective-policy set identity is not
 * on the public wire — advanced detail, never internals). No denial fact
 * ⇒ this block never renders (D19).
 */
export function blockedExplanation(fact: PolicyDenialFact): string {
  return `<div class="state state-blocked" role="status">
  <p class="state-title">Blocked by policy</p>
  <p class="state-body">The controlling rule: <strong>${esc(fact.reason)}</strong></p>
  <p class="state-source">Recorded by the platform on ${esc(
    fact.occurredAt,
  )} — policy is the admission authority; this reason is the platform's own words, rendered verbatim. How the effective rules compose (which policy set, which version) is not exposed by the public API — the admission evidence on this run is the closest public record.</p>
</div>`;
}

/**
 * The create-rejection explanation (AC2/AC8): when the governed create
 * itself is refused (POLICY_DENIED / BUDGET_EXCEEDED at admission), the
 * same blocked vocabulary renders the platform's message as the
 * controlling rule with the consequence-and-authorization framing before
 * any retry.
 */
export function createBlockedExplanation(code: string, message: string): string {
  return `<div class="state state-blocked" role="status">
  <p class="state-title">The platform refused this request — ${esc(code)}</p>
  <p class="state-body">The controlling rule: <strong>${esc(message)}</strong></p>
  <p class="state-source">Policy admission is decided platform-side at dispatch — this dashboard never re-resolves it and never retries silently. Adjust the declared controls (for example the spend limit) and submit again; the governed create carries its own consequence preview before commitment.</p>
</div>`;
}

/**
 * The effective-policy composition disclosure (AC2/IR2): the ADVANCED
 * detail — precedence and composition are policy-engine territory; the
 * public wire exposes the admission OUTCOME per run (authorized, or the
 * recorded denial reason), never the set identity. Simplified user
 * language may describe precedence, but never alters it.
 */
export function policyCompositionDisclosure(): string {
  return advancedDisclosure(
    "How the effective rules compose (advanced)",
    `<p class="muted">The effective policy is composed platform-side — tenant defaults, application rules and per-request constraints resolve into the admission decision at dispatch. The composition itself (policy set identity, version, rule precedence) is not exposed by the public API: the closest public facts are each run's admission outcome and, for a refused request, the recorded controlling rule. This dashboard simplifies the language, never the semantics — it never resolves effective policy.</p>`,
  );
}

// ---------------------------------------------------------------------------
// The spend presentation (AC3 — simple view; accounting as advanced detail)
// ---------------------------------------------------------------------------

/**
 * The simple spend view (AC3): current usage (the sum of the settled
 * costs of the runs opened in this browser — the only scope the public
 * wire supports, stated), the limits (the per-run declared spend
 * ceilings), and the major categories (the routed providers). Every
 * figure is a platform recording; the sum is BigInt arithmetic over
 * integer micro-USD strings (never floats — D20).
 */
export function spendSummarySection(input: {
  readonly facts: readonly RunSpendFact[];
  readonly totalMicroUsd: string;
  readonly categories: readonly ProviderCategoryFact[];
}): string {
  const withCost = input.facts.filter((fact) => fact.costMicroUsd !== null);
  const withLimit = input.facts.filter((fact) => fact.limitMicroUsd !== null);
  const categories =
    input.categories.length === 0
      ? '<p class="muted">No routed providers are recorded yet — every run in this scope routed deterministically or no route is recorded.</p>'
      : `<table class="kv"><tbody>${input.categories
          .map(
            (category) =>
              `<tr><th scope="row">${esc(category.provider)}</th><td>${category.runCount} run${
                category.runCount === 1 ? "" : "s"
              } · ${esc(formatMicroUsd(category.totalMicroUsd))}</td></tr>`,
          )
          .join("")}</tbody></table>`;
  return `<section class="spend-summary" aria-labelledby="spend-title">
  <h2 id="spend-title">Spend</h2>
  ${keyValueTable([
    [
      "Current usage",
      withCost.length === 0
        ? "No settled costs are recorded for the runs opened in this browser yet."
        : `${esc(formatMicroUsd(input.totalMicroUsd))} across ${withCost.length} run${
            withCost.length === 1 ? "" : "s"
          } with settled costs (runs opened in this browser — the public API exposes no cross-work spend aggregate).`,
    ],
    [
      "Limits",
      withLimit.length === 0
        ? "No run in this scope declared a spend limit — each limit is set per execution on the create request."
        : `${withLimit.length} run${withLimit.length === 1 ? " carries" : "s carry"} a declared spend limit (each enforced as its own request's cost ceiling at policy admission).`,
    ],
  ])}
  <h3>Major categories</h3>
  ${categories}
</section>`;
}

/**
 * The per-run spend table (AC3): each run's recorded cost and declared
 * limit side by side — never merged into one number, each row linking to
 * its run (the usage and the ceiling are per-run facts). A run with no
 * recorded cost renders the honest "not settled yet" note — never zero.
 */
export function spendRunsTable(facts: readonly RunSpendFact[]): string {
  if (facts.length === 0) {
    return '<p class="muted">No executions opened in this browser yet — start work or look a run up by id.</p>';
  }
  const rows = facts
    .map((fact) => {
      const id = encodeURIComponent(fact.executionId);
      const cost =
        fact.costMicroUsd === null
          ? '<span class="muted">not settled yet</span>'
          : esc(formatMicroUsd(fact.costMicroUsd));
      const limit =
        fact.limitMicroUsd === null
          ? '<span class="muted">none declared</span>'
          : esc(formatMicroUsd(fact.limitMicroUsd));
      const provider =
        fact.provider === null
          ? '<span class="muted">no route recorded</span>'
          : esc(fact.provider);
      return `<tr>
  <td><a href="/runs/${id}">${esc(fact.executionId)}</a></td>
  <td>${cost}</td>
  <td>${limit}</td>
  <td>${provider}</td>
</tr>`;
    })
    .join("\n");
  return `<table class="kv spend-runs">
  <thead><tr><th scope="col">Run</th><th scope="col">Settled cost</th><th scope="col">Declared limit</th><th scope="col">Routed provider</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

/**
 * The accounting detail disclosure (AC3/IR3): reservations, settlement
 * and the ledger are the accounting authority's own records — the
 * ADVANCED detail, honestly absent from the public API. The closest
 * public facts are the per-run settled costs above; reservations are
 * placed platform-side before dispatch, and settlement observations are
 * correlated per economic action — neither crosses the dashboard's read
 * surface. The dashboard computes no second accounting truth (D20).
 */
export function accountingDetailDisclosure(): string {
  return advancedDisclosure(
    "Reservations, settlement and the ledger (accounting detail)",
    `<p class="muted">Budget reservations are placed by the platform's accounting authority before a run dispatches; settlements are correlated external observations; the economic ledger is the authority's own durable record. None of these cross the public API surface this dashboard reads — the settled cost recorded per run is the closest public fact, and it is exactly what the simple view shows. This dashboard never computes a total that competes with the accounting authority: the browser-scoped sum above is a presentation of recorded per-run figures, labeled with its scope.</p>`,
  );
}

// ---------------------------------------------------------------------------
// The connections presentation (AC4 — health and setup, never secrets)
// ---------------------------------------------------------------------------

/**
 * The connections presentation (AC4): the platform's own opaque routing
 * strings (provider, model calls — per run, browser-scoped), the
 * BYOK/secret-mediated setup story, and the honest absence of a
 * connections inventory/health API. NO credential-shaped value renders
 * anywhere — no public wire shape even carries a field where a secret
 * could appear (the create contract REJECTS connection selection — the
 * frozen forbidden-key list — pinned by D21).
 */
export function connectionsSection(categories: readonly ProviderCategoryFact[]): string {
  const routing =
    categories.length === 0
      ? '<p class="muted">No routed providers are recorded for the runs opened in this browser yet.</p>'
      : `<table class="kv"><tbody>${categories
          .map(
            (category) =>
              `<tr><th scope="row">${esc(category.provider)}</th><td>routed for ${category.runCount} run${
                category.runCount === 1 ? "" : "s"
              } opened in this browser · ${esc(formatMicroUsd(category.totalMicroUsd))} settled</td></tr>`,
          )
          .join("")}</tbody></table>`;
  return `<section class="connection-facts" aria-labelledby="connections-title">
  <h2 id="connections-title">Routing facts (live)</h2>
  <p>Provider identifiers are the platform's own opaque neutral strings from each run's route summary — never connection handles, never credentials. These are the runs opened in this browser (the public API exposes no execution listing).</p>
  ${routing}
  <h2>Setup — bring your own keys</h2>
  <p>Connections are governed server-side: credentials are BYOK references handled by the platform's secret mediation. The create contract carries no connection field at all — provider, model, rail and connection selection are forbidden request keys, rejected fail-closed client-side and server-side. There is nothing to configure (and no credential to enter) on this surface.</p>
  <h2>Health</h2>
  <p>Connection health is decided platform-side at dispatch; no connection-health surface crosses the public API. The closest live record is each run's own outcome — open a routed run for its execution facts. Nothing here invents a health verdict.</p>
</section>`;
}

// ---------------------------------------------------------------------------
// The environments and team presentations (AC5 — safe operational intent)
// ---------------------------------------------------------------------------

/**
 * The environments presentation (AC5): the environments RECORDED on the
 * runs opened in this browser — each an isolation boundary for governed
 * work, each row linking to its runs. The environments authority's own
 inventory and configuration are not public (stated, never worked
 * around); "default" is the platform's own no-environment-recorded fact.
 */
export function environmentsSection(facts: readonly EnvironmentFact[]): string {
  if (facts.length === 0) {
    return '<p class="muted">No executions opened in this browser yet — an environment is shown here when a run records one.</p>';
  }
  const rows = facts
    .map((fact) => {
      const label = fact.environmentId === null ? "default" : esc(fact.environmentId);
      const links = fact.executionIds
        .map((id) => `<a href="/runs/${encodeURIComponent(id)}">${esc(id)}</a>`)
        .join(" · ");
      return `<li>
  <span class="distinction-state">${label}</span>
  <span class="distinction-fact">${fact.runCount} run${fact.runCount === 1 ? "" : "s"} recorded in this browser's scope</span>
  <span class="glance-kind">${links}</span>
</li>`;
    })
    .join("\n  ");
  return `<ul class="distinction-list">
  ${rows}
</ul>`;
}

/**
 * The team presentation (AC5): organized around safe operational intent —
 * the live approval queue (runs waiting for a human decision or the end
 * user's decision) and the honest membership absence. Who the approvers
 * are is membership data the public API does not expose; the queue is
 * the platform's own waiting-state record (never a role claim).
 */
export function teamSection(approvals: readonly ApprovalQueueFact[]): string {
  const queue =
    approvals.length === 0
      ? '<p class="muted">No governed work is waiting for a decision right now (in the runs opened in this browser).</p>'
      : `<ul>${approvals
          .map((item) => {
            const id = encodeURIComponent(item.executionId);
            const who =
              item.status === "WAITING_HUMAN"
                ? "a human review the governing policy required"
                : "the end user's decision";
            return `<li><a href="/runs/${id}">${esc(item.executionId)}</a> — waiting for ${esc(who)}.</li>`;
          })
          .join("")}</ul>`;
  return `<section aria-labelledby="team-title">
  <h2 id="team-title">Who decides what</h2>
  <p>Governed work never proceeds past a required decision on its own: when the effective policy requires an approval, the run records a waiting state and surfaces as an attention item. This is the live approval record — the operational intent (safe human checkpoints), not backend membership topology.</p>
  ${queue}
</section>`;
}

// ---------------------------------------------------------------------------
// The audit presentation (the live closest record)
// ---------------------------------------------------------------------------

/** One run's ledger row: the governed actions recorded on its event stream. */
export interface AuditLedgerRow {
  readonly executionId: string;
  readonly eventCount: number;
  readonly lastEventAt: string | null;
  readonly lastEventLabel: string | null;
}

/**
 * The audit presentation: per-run governed-action ledgers from the runs
 * opened in this browser — the public event streams ARE the closest live
 * audit record (every governed action on a run is recorded platform-side,
 * append-only). The audit authority's own cross-work surface is not
 * public (stated); nothing here claims to be it.
 */
export function auditLedgerSection(rows: readonly AuditLedgerRow[]): string {
  if (rows.length === 0) {
    return '<p class="muted">No executions opened in this browser yet — each opened run’s event ledger renders here.</p>';
  }
  const list = rows
    .map(
      (row) => `<li>
  <a class="run-title" href="/runs/${encodeURIComponent(row.executionId)}">${esc(
    row.executionId,
  )}</a>
  <span class="axis-fact">${row.eventCount} recorded event${row.eventCount === 1 ? "" : "s"}${
    row.lastEventLabel === null ? "" : ` · latest: ${esc(row.lastEventLabel)}`
  }${row.lastEventAt === null ? "" : ` · ${esc(row.lastEventAt)}`}</span>
  <a href="/runs/${encodeURIComponent(row.executionId)}?tab=activity">Activity</a>
</li>`,
    )
    .join("\n");
  return `<ul class="runs-list">${list}</ul>`;
}

// ---------------------------------------------------------------------------
// The Improve presentations (AC6/AC7 — evidence, recommendation, production)
// ---------------------------------------------------------------------------

/**
 * The recommendation families (AC6): the five families a platform
 * recommendation carries — observed evidence, expected impact,
 * confidence, affected work and disposition — each the explicit absence
 * anchored to where its facts will come from, with the LIVE closest
 * records linked (per-run verification evidence; the runs that produced
 * it). Rendered through the shared glance grid (IR1/IR4: every evidence
 * pointer links to the execution that produced it).
 */
export function recommendationFamiliesSection(): string {
  return glanceGrid([
    {
      label: "Observed evidence",
      fact: "The platform-recorded observations a recommendation derives from. Live today: each run's verification results and events are the closest public evidence — open a run's Evidence view. A cross-work insights evidence surface is not public yet.",
      backed: false,
    },
    {
      label: "Expected impact",
      fact: "What applying the recommendation is expected to change (cost, latency, quality) with its basis. No public expected-impact figures exist — none are invented here; when the insights authority ships, its measured/estimated basis renders with each figure.",
      backed: false,
    },
    {
      label: "Confidence",
      fact: "How strongly the platform backs the recommendation, with its population and basis. The public wire carries per-check confidence values on verification results today; recommendation-level confidence is not public yet.",
      backed: false,
    },
    {
      label: "Affected work",
      fact: "Which executions and evaluations the recommendation's evidence came from. Live pointers today: every run's own pages (the recommendation families will link the same executions when the surface ships).",
      backed: false,
    },
    {
      label: "Disposition",
      fact: "Whether the recommendation is advisory, in review, or applicable — never a claim that it is in effect. The three dispositions render as their own distinct rows below.",
      backed: false,
    },
  ]);
}

/**
 * The recommendation dispositions (AC6): advisory / review / applicable —
 * three DISTINCT dispositions through the shared distinction list, each
 * the explicit absence today, none ever derived from another (the
 * advisory→applicable conflation mutant differs — pinned by D22).
 */
export function recommendationDispositionList(): string {
  return distinctionList(
    recommendationDispositionRows() as readonly RecommendationDispositionRow[],
  );
}

/**
 * The learning-authority distinction (AC7/IR6): evidence / recommendation
 * / authoritative production — three stages, never conflated, with the
 * live production anchors (the agent inventory's selection facts) listed
 * beneath. Learning produces recommendations and evidence, never
 * authorization: the boundary sentence is part of the recommendation row
 * itself (the mutant that flips a recommendation to an authorization
 * claim differs — pinned by D22).
 */
export function learningDistinctionSection(selections: readonly AgentSelectionFact[]): string {
  const selectionList =
    selections.length === 0
      ? '<p class="muted">No agent in this application’s inventory carries a selection record yet (no promotion or rollback has been recorded), or none is exposed to this scope.</p>'
      : `<ul>${selections
          .map((selection) => {
            const id = encodeURIComponent(selection.agentId);
            return `<li><a href="/agents/${id}">${esc(selection.agentName)}</a> — ${esc(
              selection.kind === "promotion" ? "promoted" : "rolled back",
            )} by the platform's selection rules (${esc(selection.selectedBy)}, ${esc(
              selection.selectedAt,
            )})${selection.rollbackOf === null ? "" : `, rolling back ${esc(selection.rollbackOf)}`}.</li>`;
          })
          .join("")}</ul>`;
  return `${distinctionList(learningAuthorityRows() as readonly LearningAuthorityRow[])}
<section aria-labelledby="production-record-title">
  <h2 id="production-record-title">The live production record</h2>
  <p>What governed work actually runs is decided by the platform's own selection rules — the agent inventory's promotions and rollbacks are the live public record (read through the governed API):</p>
  ${selectionList}
</section>`;
}

// ---------------------------------------------------------------------------
// The shared run-link helper (IR4 — evidence links to executions)
// ---------------------------------------------------------------------------

/** The contextual run link (same-execution links only — never an index). */
export function runLink(executionId: string, label: string): string {
  return `<a href="/runs/${encodeURIComponent(executionId)}">${esc(label)}</a>`;
}
