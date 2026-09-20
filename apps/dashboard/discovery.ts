/**
 * Zeck discovery-first console presentation (PPR-001 — discovery-first
 * home, the 22-family capability catalog, the availability-state model,
 * the guided-safe-start intro and the consolidated discovery entries).
 *
 * A PROJECTION, NEVER A SECOND AUTHORITY: every fact this module renders
 * comes from the repository's validated machine artifact
 * `docs/developer/machine/capability-manifest.json` through the console
 * projection (console.ts) — the family list, the recorded classification,
 * the recorded gate (credential ENV VAR NAME) and the recorded
 * availability sentence, verbatim. The four-state availability vocabulary
 * below is a DERIVED PRESENTATION of those manifest fields (the work
 * order's Available / Provider-gated / Requires access / NOT RUN
 * vocabulary); it adds no fact the manifest does not carry, and a
 * recorded gap stays a gap — never a silent pass.
 *
 * The derivation, stated once (availabilityStateOf):
 *  - classification "runnable"                              -> available
 *  - provider-gated + availability records a leading
 *    "NOT RUN" boundary                                     -> not-run
 *  - provider-gated + the manifest records gatedBy (a
 *    credential env-var NAME)                               -> requires-access
 *  - provider-gated otherwise (no recorded gate; the family is
 *    fixture-proven but no operator-authorized live rail)   -> provider-gated
 *
 * The recorded availability sentence always renders verbatim next to the
 * derived state — the state is the coarse scan aid, the sentence is the
 * truth.
 */

import { esc } from "./components";
import { type ConsoleFamily, consoleFamilies, familiesByClassification } from "./console";

// ---------------------------------------------------------------------------
// The availability-state vocabulary (a derived presentation, not a
// second classification authority)
// ---------------------------------------------------------------------------

/** The four discovery states (PPR-001's vocabulary). */
export const AVAILABILITY_STATES = [
  "available",
  "requires-access",
  "provider-gated",
  "not-run",
] as const;

export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/** The rendered label for each state (never color alone — symbol + text). */
export const AVAILABILITY_STATE_LABELS: Readonly<Record<AvailabilityState, string>> = {
  available: "Available",
  "requires-access": "Requires access",
  "provider-gated": "Provider-gated",
  "not-run": "NOT RUN",
};

/**
 * Derive one family's discovery state from the manifest's own fields.
 * Pure, total, and the ONE definition — the catalog, the playground
 * table, the home grid and the route matrix all consume it.
 */
export function availabilityStateOf(family: ConsoleFamily): AvailabilityState {
  if (family.classification === "runnable") {
    return "available";
  }
  if (family.availability.trim().toUpperCase().startsWith("NOT RUN")) {
    return "not-run";
  }
  if (family.gatedBy !== undefined) {
    return "requires-access";
  }
  return "provider-gated";
}

/** The state chip (symbol + text — the same discipline as classificationChip). */
export function availabilityStateChip(state: AvailabilityState): string {
  switch (state) {
    case "available":
      return '<span class="chip state-available">▶ Available</span>';
    case "requires-access":
      return '<span class="chip state-requires-access">◆ Requires access</span>';
    case "not-run":
      return '<span class="chip state-not-run">∅ NOT RUN</span>';
    default:
      return '<span class="chip state-provider-gated">⊘ Provider-gated</span>';
  }
}

/** The state chip for one family (the derived state of its manifest fields). */
export function familyAvailabilityChip(family: ConsoleFamily): string {
  return availabilityStateChip(availabilityStateOf(family));
}

/** The state counts over the whole 22-family catalog (manifest order). */
export function catalogCounts(): Readonly<Record<AvailabilityState, number>> {
  const counts: Record<AvailabilityState, number> = {
    available: 0,
    "requires-access": 0,
    "provider-gated": 0,
    "not-run": 0,
  };
  for (const family of consoleFamilies()) {
    counts[availabilityStateOf(family)] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// The route/discoverability matrix (REQUIRED PPR-001 evidence: every
// workload family -> its discovery location -> its honest availability
// state). Pure data — the tests and the evidence record consume it.
// ---------------------------------------------------------------------------

export interface FamilyRouteMatrixRow {
  readonly family: string;
  /** The primary discovery location (the catalog row links into the family page). */
  readonly discoveryLocation: string;
  /** The guided-run location (the playground family page). */
  readonly guidedRunLocation: string;
  readonly availabilityState: AvailabilityState;
  /** The manifest's recorded classification (verbatim vocabulary). */
  readonly classification: string;
}

/** The 22-row matrix: family -> catalog + family page -> honest state. */
export function routeMatrix(): readonly FamilyRouteMatrixRow[] {
  return consoleFamilies().map((family) => ({
    family: family.family,
    discoveryLocation: "/console/catalog",
    guidedRunLocation: `/console/playground/${encodeURIComponent(family.family)}`,
    availabilityState: availabilityStateOf(family),
    classification: family.classification,
  }));
}

/**
 * The route/discoverability matrix as a console surface (PPR-001's
 * REQUIRED evidence rendered where users and agents can read it): every
 * family, its discovery location, its guided-run location and its honest
 * state. The tests and the evidence record consume the same
 * `routeMatrix()` data — one definition, no drift.
 */
export function routeMatrixSection(): string {
  const rows = routeMatrix()
    .map(
      (row) => `<tr>
      <td>${esc(row.family)}</td>
      <td><a href="${esc(row.discoveryLocation)}">${esc(row.discoveryLocation)}</a></td>
      <td><a href="${esc(row.guidedRunLocation)}">${esc(row.guidedRunLocation)}</a></td>
      <td>${availabilityStateChip(row.availabilityState)}</td>
      <td>${esc(row.classification)}</td>
    </tr>`,
    )
    .join("\n      ");
  return `<table class="data">
  <thead><tr><th scope="col">Family</th><th scope="col">Discovery location</th><th scope="col">Guided run</th><th scope="col">Availability state</th><th scope="col">Recorded classification</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

// ---------------------------------------------------------------------------
// The capability catalog (the full 22-family surface at /console/catalog)
// ---------------------------------------------------------------------------

/**
 * The catalog table: every family, its derived state chip, its recorded
 * availability VERBATIM, its classification, and links to the guided run
 * and the copyable example. The family link is the first cell (the
 * playground table's scan order is preserved on its own surface).
 */
export function catalogTable(): string {
  const rows = consoleFamilies()
    .map(
      (family) => `<tr>
      <td><a href="/console/playground/${encodeURIComponent(
        family.family,
      )}">${esc(family.family)}</a></td>
      <td>${familyAvailabilityChip(family)}</td>
      <td>${esc(family.availability)}</td>
      <td>${classificationText(family)}</td>
      <td class="mono"><a href="/console/playground/${encodeURIComponent(
        family.family,
      )}/example">${esc(family.example)}</a></td>
    </tr>`,
    )
    .join("\n      ");
  return `<table class="data catalog-table">
  <thead><tr><th scope="col">Family</th><th scope="col">Availability state</th><th scope="col">Recorded availability</th><th scope="col">Recorded classification</th><th scope="col">Example</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function classificationText(family: ConsoleFamily): string {
  return esc(family.classification);
}

/** The catalog summary line (counts per state — the "available now" answer). */
export function catalogSummaryLine(): string {
  const counts = catalogCounts();
  const split = familiesByClassification();
  return `${counts.available} families are available now (the integration path is live for any deployment exposing the public API); ${counts["requires-access"]} require provider access (a credential the deployment must carry); ${counts["provider-gated"]} are provider-gated with no operator-authorized live rail yet; ${counts["not-run"]} record an honest NOT RUN boundary. The manifest's own split: ${split.runnable.length} runnable / ${split.providerGated.length} provider-gated.`;
}

/** The full catalog page section (the /console/catalog body). */
export function catalogSection(): string {
  return `<section class="card" id="catalog">
  <h2>The 22 workload families</h2>
  <p>Every workload class the platform supports, projected from the machine capability manifest — the same artifact the validation program validates, so this catalog can never drift from it. Each row carries the honest availability state first; the recorded availability sentence renders verbatim beside it.</p>
  ${catalogTable()}
  <p class="muted">${esc(catalogSummaryLine())}</p>
  <p class="muted">A recorded gap is never converted into a pass. Try any family safely from its row — the guided sandbox start links the text family below; provider-gated families name their boundary on the family page.</p>
</section>`;
}

// ---------------------------------------------------------------------------
// The discovery-first home sections (PPR-001: the first screen answers,
// in order — what Zeck does; what workloads exist; what is available
// right now; how to try safely)
// ---------------------------------------------------------------------------

/** The home hero: what Zeck does + the ONE dominant action. */
export function discoveryHero(): string {
  return `<section class="discovery-hero" aria-labelledby="discovery-hero-title">
  <p class="hero-kicker">What Zeck does</p>
  <h2 id="discovery-hero-title">Describe an outcome. Zeck plans it, executes it under policy, and returns it with evidence.</h2>
  <p class="hero-lead">Zeck is governed AI execution infrastructure: one public create contract carries your task and its limits, the platform plans the route over neutral provider rails, policy admission governs every dispatch, and the result comes back with verification evidence, the recorded route and the settled cost. No provider, model or connection is ever selected by you — and every fact on this console is a live read through the governed public API.</p>
  <div class="hero-actions">
    <a class="button-link primary hero-cta" href="/console/start">Start the guided sandbox<span class="muted">— one text execution, safe limits, end to end</span></a>
  </div>
  <ul class="hero-facts">
    <li><strong>22 workload families</strong><span class="muted">from text to computer-use</span></li>
    <li><strong>$2.00 budget ceiling</strong><span class="muted">on every sandbox run</span></li>
    <li><strong>Synthetic data only</strong><span class="muted">in the guided sandbox</span></li>
  </ul>
</section>`;
}

/**
 * The home catalog grid: all 22 families, each linked to its guided-run
 * page with its state chip — the "what workloads exist / what is
 * available right now" answer on one screen.
 */
export function discoveryCatalogGrid(): string {
  const items = consoleFamilies()
    .map(
      (family) => `<li>
      <a href="/console/playground/${encodeURIComponent(family.family)}">${esc(family.family)}</a>
      ${familyAvailabilityChip(family)}
    </li>`,
    )
    .join("\n    ");
  return `<section class="discovery-section" aria-labelledby="discovery-catalog-title">
  <h2 id="discovery-catalog-title">The workload families</h2>
  <p class="muted">${esc(catalogSummaryLine())}</p>
  <ul class="availability-grid">
    ${items}
  </ul>
  <p><a href="/console/catalog">Browse the full capability catalog</a> — every family's recorded availability, verbatim, in one place.</p>
</section>`;
}

/** The home "try safely" section (the safety envelope, before any form). */
export function discoverySafeStartSection(): string {
  return `<section class="discovery-section" aria-labelledby="discovery-safe-title">
  <h2 id="discovery-safe-title">Try it safely</h2>
  <p>The guided sandbox start shows the full safety envelope before anything runs: a $2.00 per-run budget ceiling and a two-minute latency ceiling carried on every request, at most three in-flight sandbox runs, synthetic data only, a disposable-sandbox identity on every run, and provider selection made impossible by the frozen create contract. Platform-side policy admission stays the governing boundary on every run.</p>
  <p><a class="button-link primary" href="/console/start">Start the guided sandbox</a></p>
</section>`;
}

/** The home discovery entries (Validation Lab, Trust & Limits, For agents). */
export function discoveryEntries(): string {
  return `<div class="tiles discovery-entries">
  <section class="tile">
    <h3><a href="/console/validation">Validation Lab</a></h3>
    <p>The executed validation program — every experiment, its evidence, safe reruns and the agent interface.</p>
    <p class="muted">Live — projected from repository truth.</p>
  </section>
  <section class="tile">
    <h3><a href="/trust/limits">Trust &amp; Limits</a></h3>
    <p>Policy, spend, the sandbox envelope and verification — the consolidated view.</p>
    <p class="muted">Live — links to the governing surfaces.</p>
  </section>
  <section class="tile">
    <h3><a href="/console/docs/AGENT-GUIDE.md">For agents</a></h3>
    <p>The agent integration guide plus the machine-readable contract layer — discover and integrate Zeck from files alone.</p>
    <p class="muted">Live — the public integration kit, verbatim.</p>
  </section>
  <section class="tile">
    <h3><a href="/console/quickstart">Developers</a></h3>
    <p>The five-step quickstart, the SDK docs and the full developer kit.</p>
    <p class="muted">Live — served from the repository.</p>
  </section>
</div>`;
}

// ---------------------------------------------------------------------------
// The guided safe sandbox start (PPR-001: the safety envelope surfaces
// BEFORE the first execution; pages.ts composes this with the live
// composer for the text family)
// ---------------------------------------------------------------------------

/** The guided-start "what will happen" steps (outcome-first, no jargon first). */
export function guidedStartSteps(): string {
  return `<ol class="steps">
  <li><strong>See the safety envelope.</strong> The quotas, the identity, the expiry/reset discipline and the synthetic-data policy render on this page before anything runs — you know the boundaries first.</li>
  <li><strong>Compose the run.</strong> One synthetic text task (the manifest's recorded summarization shape), editable within the recorded envelope, with the optional spend ceiling already capped by the sandbox limit.</li>
  <li><strong>Run it end to end.</strong> The run is an ordinary governed execution through the public create contract — the same wire path every production execution takes.</li>
  <li><strong>Inspect how Zeck did it.</strong> The result lands with verification evidence, the recorded route, the settled cost and the full "How Zeck did it" hierarchy open on the result page.</li>
</ol>`;
}

// ---------------------------------------------------------------------------
// The consolidated Trust & Limits entry (/trust/limits — a discovery
// surface over the EXISTING authorities; it links, it never re-decides)
// ---------------------------------------------------------------------------

/** The Trust & Limits page body: policy, spend, sandbox, verification. */
export function trustLimitsSection(): string {
  return `<div class="tiles">
  <section class="tile">
    <h3><a href="/admin/policies">Policy</a></h3>
    <p>Rules and controls in user language; the live denial reason per run renders on its result page.</p>
    <p class="muted">The policy authority through the public API — this console never re-resolves a rule.</p>
  </section>
  <section class="tile">
    <h3><a href="/admin/budgets">Spend</a></h3>
    <p>Per-run spend, limits and categories, plus the usage projection over the same public records.</p>
    <p class="muted">Live per run · <a href="/console/usage">Usage &amp; economics</a> carries the per-run token and cost facts.</p>
  </section>
  <section class="tile">
    <h3><a href="/console/applications/environments">Sandbox</a></h3>
    <p>The sandbox governance surface: budgets, quotas, identity expiry/reset and the synthetic-data policy.</p>
    <p class="muted">The sandbox envelope this console enforces on every guided run renders on the <a href="/console/start">guided start</a> too.</p>
  </section>
  <section class="tile">
    <h3><a href="/trust/evidence">Verification</a></h3>
    <p>Verification evidence behind every run, per execution, with the four trust axes on the result page.</p>
    <p class="muted">Live per run; cross-work evidence search is not public yet.</p>
  </section>
</div>
<p class="muted">This page consolidates the entrances — each tile opens the governing surface that owns its facts. Nothing here is a second authority: policy, budgets, sandbox governance and verification stay exactly where the platform holds them.</p>`;
}

// ---------------------------------------------------------------------------
// The mobile bottom navigation (PPR-001's ShareNet-inspired grammar: a
// quiet persistent primary bar on the mobile viewport class; the desktop
// sidebar and the full grouped menu stay the same routes — visibility
// only, never semantics)
// ---------------------------------------------------------------------------

export interface MobileNavItem {
  readonly label: string;
  readonly path: string;
}

/** The five primary destinations of the mobile bottom bar (real routes). */
export const MOBILE_NAV_ITEMS: readonly MobileNavItem[] = [
  { label: "Home", path: "/" },
  { label: "Start", path: "/console/start" },
  { label: "Catalog", path: "/console/catalog" },
  { label: "Validation", path: "/console/validation" },
  { label: "Trust", path: "/trust/limits" },
];
