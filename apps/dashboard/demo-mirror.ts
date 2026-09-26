/**
 * The Demo Mirror (PPR-017 / ACR-006 §5) — the public website surface
 * for application compatibility demos.
 *
 * A PROJECTION, NEVER A SECOND AUTHORITY: every fact this surface
 * renders comes from the compatibility integration's public barrel
 * (src/integrations/compatibility/public — the PPR-017 foundation),
 * which derives every status from evidence records through the strict
 * admission evaluation. This module holds NO status, NO verdict and NO
 * completeness claim of its own:
 *
 *  - PARTIAL / BLOCKED / BYPASS_DETECTED / UNASSESSED demos are
 *    VISUALLY DISTINCT from AI_EXECUTION_COMPLETE (five different chip
 *    treatments — symbol + text + color, never color alone);
 *  - the run control renders the honest not-runnable state for
 *    anything not certified (the mirror never executes an uncertified
 *    integration path, never fabricates a result, and never upgrades
 *    certification status — the status is derived from the bound
 *    record on every render);
 *  - fixture-bound demos disclose their fixture basis on every view.
 *
 * The PPR-017 demo examples are honestly-labeled UNASSESSED / PARTIAL
 * FIXTURES (no application proof exists yet — the sibling application
 * orders PPR-018/PPR-019 are in flight and re-bind these entries to
 * live evidence records when their proofs land).
 *
 * ROUTES (under the already-experience-rewritten /console prefix — no
 * vercel.json change, no new API plane):
 *   GET  /console/demos                     — the registry index
 *   GET  /console/demos/facts.json          — the machine twin (index)
 *   GET  /console/demos/:demoId             — the demo shell
 *   GET  /console/demos/:demoId/facts.json  — the machine twin (detail)
 *   POST /console/demos/:demoId/run         — the run initiation (honest
 *                                             refusal for uncertified
 *                                             demos; PRG back to detail)
 */

import {
  type CompatibilityEvidenceRecord,
  type CompatibilityStatus,
  type DemoMirrorEntry,
  type DemoMirrorResolution,
  defaultDemoEntries,
  defaultDemoRegistry,
  EXAMPLE_CODING_ASSISTANT_RECORD,
  EXAMPLE_RAG_KNOWLEDGE_APP_RECORD,
  FIXTURE_EVIDENCE_RECORDS,
  fixtureRecordOf,
  resolveDemoMirrorEntry,
  validateDemoRegistry,
} from "../../src/integrations/compatibility/public";
import { esc, keyValueTable } from "./components";
import { emptyState, errorState } from "./states";

// ---------------------------------------------------------------------------
// The status presentation vocabulary (five VISUALLY DISTINCT treatments)
// ---------------------------------------------------------------------------

/** The symbol + label per compatibility status (never color alone). */
export const COMPATIBILITY_STATUS_PRESENTATION: Readonly<
  Record<CompatibilityStatus, { readonly symbol: string; readonly label: string }>
> = {
  UNASSESSED: { symbol: "∅", label: "UNASSESSED" },
  PARTIAL: { symbol: "◐", label: "PARTIAL" },
  BLOCKED: { symbol: "⊘", label: "BLOCKED" },
  BYPASS_DETECTED: { symbol: "⚠", label: "BYPASS DETECTED" },
  AI_EXECUTION_COMPLETE: { symbol: "✓", label: "AI EXECUTION COMPLETE" },
};

/** The status chip (five distinct treatments: hollow grey / amber / dashed / red / green). */
export function compatibilityStatusChip(status: CompatibilityStatus): string {
  const presentation = COMPATIBILITY_STATUS_PRESENTATION[status];
  return `<span class="chip compat-${status}" data-compat-status="${esc(status)}">${presentation.symbol} ${esc(
    presentation.label,
  )}</span>`;
}

/** The status banner (the always-visible honesty statement of a demo). */
function compatibilityStatusBanner(status: CompatibilityStatus, recordBasis: string): string {
  const presentation = COMPATIBILITY_STATUS_PRESENTATION[status];
  const basis =
    recordBasis === "fixture"
      ? "This demo is bound to an honest FIXTURE evidence record — proof scaffolding for the foundation itself; it can never show a certified run."
      : "This demo is bound to a live compatibility evidence record.";
  return `<div class="compat-banner compat-${status}" data-compat-status="${esc(status)}">
  <p><strong>${presentation.symbol} ${esc(presentation.label)}</strong> — derived from the bound evidence record by the strict ACR-006 admission evaluation (five rules; a demo can never upgrade it).</p>
  <p class="muted">${esc(basis)}</p>
</div>`;
}

// ---------------------------------------------------------------------------
// The registry resolutions (the projection over the foundation's data)
// ---------------------------------------------------------------------------

/**
 * The record source for the demo projection: the PPR-017 fixture
 * records (the honest foundation demos). When the sibling application
 * proofs land, their file-based evidence records extend this source
 * through the same resolution path — one definition, no drift.
 */
function recordOf(recordId: string): CompatibilityEvidenceRecord | null {
  return fixtureRecordOf(recordId);
}

/** Resolve every default registry entry (the index projection). */
export function demoMirrorIndexRows(): readonly {
  readonly demoId: string;
  readonly applicationName: string;
  readonly status: CompatibilityStatus;
  readonly pin: { upstreamRevision: string; integrationRevision: string };
  readonly runAvailable: boolean;
  readonly recordBasis: string;
}[] {
  return defaultDemoEntries().flatMap((entry) => {
    const resolution = resolveDemoMirrorEntry(entry, recordOf(entry.evidenceRecordId));
    if (resolution.kind !== "available") {
      return [];
    }
    const { projection } = resolution;
    return [
      {
        demoId: projection.demoId,
        applicationName: projection.applicationName,
        status: projection.status,
        pin: projection.pin,
        runAvailable: projection.runAvailability.available,
        recordBasis: projection.recordBasis,
      },
    ];
  });
}

/** The index table (every registry entry with its derived status). */
function demoMirrorIndexTable(): string {
  const rows = demoMirrorIndexRows()
    .map(
      (row) => `<tr>
      <td><a href="/console/demos/${esc(row.demoId)}">${esc(row.applicationName)}</a></td>
      <td>${compatibilityStatusChip(row.status)}</td>
      <td class="mono">${esc(row.pin.upstreamRevision.slice(0, 12))}</td>
      <td class="mono">${esc(row.pin.integrationRevision.slice(0, 12))}</td>
      <td>${row.runAvailable ? "Run available" : '<span class="muted">Not runnable (uncertified)</span>'}</td>
    </tr>`,
    )
    .join("\n      ");
  return `<table class="data">
  <thead><tr><th scope="col">Application</th><th scope="col">Compatibility status</th><th scope="col">Pinned upstream</th><th scope="col">Integration</th><th scope="col">Run</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

// ---------------------------------------------------------------------------
// The demo shell sections (the ACR-006 §5 required flow, in order)
// ---------------------------------------------------------------------------

function pinnedRevisionSection(record: CompatibilityEvidenceRecord): string {
  const pin = record.pinnedApplication.pin;
  return `<section class="card" aria-labelledby="demo-pin-title">
  <h2 id="demo-pin-title">Pinned application revision</h2>
  ${keyValueTable([
    ["Application", record.pinnedApplication.identity.name],
    ["Upstream repository", record.pinnedApplication.identity.repository],
    ["Zeck application id", record.pinnedApplication.identity.applicationId],
    ["Pinned upstream revision", pin.upstreamRevision],
    ["Integration revision", pin.integrationRevision],
    ["Recorded at", record.recordedAt],
    [
      "Record basis",
      record.recordBasis === "fixture"
        ? "FIXTURE (proof scaffolding — never certifiable)"
        : "live proof",
    ],
  ])}
  <p class="muted">Both revisions are mandatory and immutable once declared: a compatibility claim is only meaningful against exact revisions, and a demo entry whose pins disagree with its bound record is a named registry defect — never rendered as a demo.</p>
</section>`;
}

function representativeTaskSection(entry: DemoMirrorEntry): string {
  return `<section class="card" aria-labelledby="demo-task-title">
  <h2 id="demo-task-title">Representative task</h2>
  <p><strong>${esc(entry.representativeTask.title)}</strong></p>
  <p>${esc(entry.representativeTask.description)}</p>
</section>`;
}

function runInitiationSection(entry: DemoMirrorEntry, resolution: DemoMirrorResolution): string {
  if (resolution.kind !== "available") {
    return "";
  }
  const { runAvailability } = resolution.projection;
  if (runAvailability.available) {
    return `<section class="card" aria-labelledby="demo-run-title">
  <h2 id="demo-run-title">Run this application through Zeck</h2>
  <p>The run replays the representative task through the certified integration path — the same pinned runtime the compatibility proof certified, never a toy response generator.</p>
  <form method="post" action="/console/demos/${esc(entry.demoId)}/run">
    <button type="submit" class="button primary">Run the representative task</button>
  </form>
</section>`;
  }
  return `<section class="card" aria-labelledby="demo-run-title">
  <h2 id="demo-run-title">Run this application through Zeck</h2>
  ${emptyState(
    "No certified run exists",
    runAvailability.reason,
    "When the bound evidence record certifies (every declared material AI edge delegated through Zeck, egress absent or provably blocked, corpus usable, Zeck evidence for every edge, no fixture counted as external PASS), the run control activates for the certified integration path.",
  )}
</section>`;
}

function liveProgressSection(record: CompatibilityEvidenceRecord): string {
  const hasLiveRun = record.zeckTraces.some((trace) => trace.found);
  if (!hasLiveRun) {
    return `<section class="card" aria-labelledby="demo-progress-title">
  <h2 id="demo-progress-title">Live progress &amp; application result</h2>
  ${emptyState(
    "No run has been initiated",
    "No certified run exists for this demo yet, so there is no live progress and no application result to show — the Demo Mirror never fabricates either.",
    "A certified run streams its progress here and lands its application result in this section.",
  )}
</section>`;
  }
  return `<section class="card" aria-labelledby="demo-progress-title">
  <h2 id="demo-progress-title">Live progress &amp; application result</h2>
  <p>The bound record carries ${record.zeckTraces.length} correlated Zeck execution trace fact(s) (see the execution timeline below). The application result of a certified run lands here; for this record, the traces below are the durable evidence the proof recorded.</p>
</section>`;
}

function executionTimelineSection(record: CompatibilityEvidenceRecord): string {
  if (record.zeckTraces.length === 0) {
    return `<section class="card" aria-labelledby="demo-timeline-title">
  <h2 id="demo-timeline-title">Zeck execution timeline</h2>
  ${emptyState(
    "No Zeck executions correlated",
    "The bound record carries no correlated Zeck execution traces — nothing ran through Zeck for this proof yet, and the timeline is honestly empty.",
  )}
</section>`;
  }
  const rows = record.zeckTraces
    .map(
      (trace) => `<tr>
      <td class="mono">${esc(trace.edgeId)}</td>
      <td class="mono">${esc(trace.executionId)}</td>
      <td>${esc(trace.status ?? "not found")}${trace.terminal ? " (terminal)" : ""}</td>
      <td>${trace.eventCount}</td>
      <td>${trace.verificationCount} (${trace.passingVerificationCount} PASS)</td>
      <td>${trace.correlated ? "Yes" : '<span class="muted">No durable evidence</span>'}</td>
    </tr>`,
    )
    .join("\n      ");
  return `<section class="card" aria-labelledby="demo-timeline-title">
  <h2 id="demo-timeline-title">Zeck execution timeline</h2>
  <p>Every delegated edge's Zeck execution, read back through the executions public surface and durably recorded in the evidence: lifecycle status, ledger events, verification results.</p>
  <table class="data">
    <thead><tr><th scope="col">Edge</th><th scope="col">Zeck execution</th><th scope="col">Status</th><th scope="col">Events</th><th scope="col">Verification</th><th scope="col">Correlated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function executionFactsSection(record: CompatibilityEvidenceRecord): string {
  const rows: (readonly [string, string])[] = [];
  const withRoute = record.zeckTraces.find(
    (trace) => trace.route !== undefined && trace.route !== null,
  );
  const withCost = record.zeckTraces.find(
    (trace) => trace.costMicroUsd !== undefined && trace.costMicroUsd !== null,
  );
  rows.push([
    "Route (provider / model / strategy)",
    withRoute?.route
      ? `${withRoute.route?.provider ?? "—"} / ${withRoute.route?.model ?? "—"} (${withRoute.route?.strategyClass ?? "—"})`
      : "Not carried in this record (no planning route facts projected)",
  ]);
  rows.push([
    "Cost",
    withCost?.costMicroUsd !== undefined && withCost?.costMicroUsd !== null
      ? `${withCost.costMicroUsd} micro-USD (settled)`
      : "Not carried in this record (no settled cost facts projected)",
  ]);
  rows.push([
    "Usage / latency",
    "Not carried in this record (no settled usage or latency facts projected)",
  ]);
  return `<section class="card" aria-labelledby="demo-facts-title">
  <h2 id="demo-facts-title">Execution representation &amp; economics</h2>
  ${keyValueTable(rows)}
  <p class="muted">Route, cost, latency and usage facts render when the correlated executions carry them (the same public ledger facts the result package projects); absent facts render as absent — never fabricated.</p>
</section>`;
}

function verificationEvidenceSection(resolution: DemoMirrorResolution): string {
  if (resolution.kind !== "available") {
    return "";
  }
  const ruleRows = resolution.projection.ruleResults
    .map(
      (rule) => `<tr>
      <td>${esc(rule.ruleId)}</td>
      <td>${rule.satisfied ? "Satisfied" : '<span class="muted">Not satisfied</span>'}</td>
      <td>${esc(rule.detail)}</td>
    </tr>`,
    )
    .join("\n      ");
  return `<section class="card" aria-labelledby="demo-evidence-title">
  <h2 id="demo-evidence-title">Verification &amp; evidence</h2>
  <p>The five strict ACR-006 admission rules, evaluated over the bound record (the same evaluation that derived the status above):</p>
  <table class="data">
    <thead><tr><th scope="col">Admission rule</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
    <tbody>${ruleRows}</tbody>
  </table>
</section>`;
}

function warningsLimitationsSection(
  record: CompatibilityEvidenceRecord,
  resolution: DemoMirrorResolution,
): string {
  if (resolution.kind !== "available") {
    return "";
  }
  const warnings = resolution.projection.warnings
    .map((warning) => `<li>${esc(warning)}</li>`)
    .join("\n  ");
  const limitations = record.limitations
    .map(
      (limitation) =>
        `<li><strong>${esc(limitation.area)}</strong> — ${esc(limitation.statement)} <span class="muted">(owner: ${esc(limitation.owner)})</span></li>`,
    )
    .join("\n  ");
  const notRun = record.notRunCauses
    .map(
      (cause) =>
        `<li><strong>${esc(cause.area)}</strong> — ${esc(cause.cause)} <span class="muted">(owner: ${esc(cause.owner)})</span></li>`,
    )
    .join("\n  ");
  return `<section class="card" aria-labelledby="demo-warnings-title">
  <h2 id="demo-warnings-title">Warnings, limitations &amp; NOT RUN</h2>
  ${warnings === "" ? "" : `<ul>${warnings}</ul>`}
  <h3>Limitations</h3>
  ${limitations === "" ? '<p class="muted">No limitations recorded.</p>' : `<ul>${limitations}</ul>`}
  <h3>NOT RUN causes</h3>
  ${notRun === "" ? '<p class="muted">No NOT-RUN causes recorded.</p>' : `<ul>${notRun}</ul>`}
</section>`;
}

function baselineComparisonSection(record: CompatibilityEvidenceRecord): string {
  if (record.comparison.length === 0) {
    return `<section class="card" aria-labelledby="demo-compare-title">
  <h2 id="demo-compare-title">Baseline comparison</h2>
  ${emptyState(
    "No baseline comparison evidence",
    "The bound record carries no measured baseline comparison — cost per successfully resolved outcome against direct and optimized baselines renders here when the proof measures it.",
  )}
</section>`;
  }
  const rows = record.comparison
    .map(
      (fact) => `<tr>
      <td>${esc(fact.baseline)}</td>
      <td>${esc(fact.basis)}</td>
      <td>${esc(fact.statement)}</td>
    </tr>`,
    )
    .join("\n      ");
  return `<section class="card" aria-labelledby="demo-compare-title">
  <h2 id="demo-compare-title">Baseline comparison</h2>
  <table class="data">
    <thead><tr><th scope="col">Baseline</th><th scope="col">Basis</th><th scope="col">Statement</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function reproducibilitySection(entry: DemoMirrorEntry): string {
  return `<section class="card" aria-labelledby="demo-repro-title">
  <h2 id="demo-repro-title">Reproducibility</h2>
  <p>${esc(entry.reproducibility.instructions)}</p>
  ${keyValueTable([
    ["Pinned upstream revision", entry.reproducibility.pinnedUpstreamRevision],
    ["Integration revision", entry.reproducibility.integrationRevision],
  ])}
</section>`;
}

// ---------------------------------------------------------------------------
// The pages (index + detail) and the machine twins
// ---------------------------------------------------------------------------

/** The Demo Mirror index body (the registry + the honest status column). */
export function demoMirrorIndexBody(): string {
  const registry = defaultDemoRegistry();
  const issues = validateDemoRegistry(registry);
  const registryError =
    issues.length > 0
      ? errorState(
          "The demo registry is structurally invalid",
          "A registry defect is a named failure — the index renders what it can and names the defect rather than guessing.",
          issues
            .map((issue) =>
              issue.demoId === undefined ? issue.issue : `${issue.demoId}: ${issue.issue}`,
            )
            .join("; "),
        )
      : "";
  return `${registryError}
<p>The Demo Mirror shows real applications running with Zeck as their AI execution authority — every demo bound to a compatibility evidence record, every status derived from that record by the strict ACR-006 admission evaluation. PARTIAL, BLOCKED, BYPASS_DETECTED and UNASSESSED demos are visually distinct from AI EXECUTION_COMPLETE, and the mirror never upgrades a status for presentation.</p>
${demoMirrorIndexTable()}
<p class="muted">The current entries are honest FIXTURE demos of the PPR-017 foundation itself (no application proof exists yet — the first application proofs are the sibling orders in flight). When an application's proof lands, its entry binds to the live evidence record and — only when every declared material AI edge is delegated, egress is absent or provably blocked, the corpus stays usable, Zeck evidence correlates every edge, and no fixture is counted as an external PASS — the certified run activates.</p>`;
}

/** One demo's full shell body (the ACR-006 §5 flow, in order). */
export function demoMirrorDetailBody(demoId: string): {
  readonly title: string;
  readonly body: string;
} {
  const entry = defaultDemoEntries().find((candidate) => candidate.demoId === demoId) ?? null;
  if (entry === null) {
    return {
      title: "Demo not found",
      body: errorState(
        "This demo does not exist",
        `No Demo Mirror entry is registered under "${demoId}". Open the demo index for every registered entry.`,
      ),
    };
  }
  const record = recordOf(entry.evidenceRecordId);
  const resolution = resolveDemoMirrorEntry(entry, record);
  if (resolution.kind === "record-missing") {
    return {
      title: entry.representativeTask.title,
      body: errorState(
        "The bound evidence record is missing",
        `This demo entry binds evidence record "${resolution.evidenceRecordId}", which does not exist in the record source — a registry defect, named honestly. The demo renders no projection rather than guessing a status.`,
        "The Demo Mirror never falls back to a default status: a missing record is a missing record.",
      ),
    };
  }
  if (resolution.kind === "revision-mismatch") {
    return {
      title: entry.representativeTask.title,
      body: errorState(
        "The demo entry's revision pins disagree with the bound record",
        resolution.detail,
      ),
    };
  }
  if (resolution.kind !== "available") {
    // Structurally unreachable here (the entry exists and the record
    // resolved), but the projection refuses to guess — fail closed.
    return {
      title: entry.representativeTask.title,
      body: errorState(
        "The demo projection could not be resolved",
        "The registry entry resolved to neither a projection nor a named defect — the surface refuses to render a guess.",
      ),
    };
  }
  const { projection } = resolution;
  const body = `${compatibilityStatusBanner(projection.status, projection.recordBasis)}
${pinnedRevisionSection(record as CompatibilityEvidenceRecord)}
${representativeTaskSection(entry)}
${runInitiationSection(entry, resolution)}
${liveProgressSection(record as CompatibilityEvidenceRecord)}
${executionTimelineSection(record as CompatibilityEvidenceRecord)}
${executionFactsSection(record as CompatibilityEvidenceRecord)}
${verificationEvidenceSection(resolution)}
${warningsLimitationsSection(record as CompatibilityEvidenceRecord, resolution)}
${baselineComparisonSection(record as CompatibilityEvidenceRecord)}
${reproducibilitySection(entry)}`;
  return { title: `${projection.applicationName} — demo`, body };
}

/** The index machine twin (the same projection, JSON). */
export function demoMirrorIndexFactsJson(): string {
  return JSON.stringify(
    {
      surface: "demo-mirror",
      note: "The machine twin of the Demo Mirror index: every status derived from the bound evidence record through the strict admission evaluation — never asserted.",
      demos: demoMirrorIndexRows(),
    },
    null,
    2,
  );
}

/** The detail machine twin (the same projection, JSON). */
export function demoMirrorDetailFactsJson(demoId: string): string {
  const entry = defaultDemoEntries().find((candidate) => candidate.demoId === demoId) ?? null;
  if (entry === null) {
    return JSON.stringify({ surface: "demo-mirror", demoId, error: "unknown-demo" }, null, 2);
  }
  const resolution = resolveDemoMirrorEntry(entry, recordOf(entry.evidenceRecordId));
  if (resolution.kind !== "available") {
    return JSON.stringify({ surface: "demo-mirror", demoId, resolution }, null, 2);
  }
  const record = recordOf(entry.evidenceRecordId);
  return JSON.stringify(
    {
      surface: "demo-mirror",
      demoId,
      projection: resolution.projection,
      edgeDispositions: record?.dispositions ?? [],
      zeckTraces: record?.zeckTraces ?? [],
    },
    null,
    2,
  );
}

/**
 * The run initiation handler (POST): the ONLY mutation-shaped route of
 * the demo surface, and it is an HONEST REFUSAL for anything not
 * certified — the certified-runner path activates only when the bound
 * record derives AI_EXECUTION_COMPLETE (the projection's derived run
 * availability), and no PPR-017 fixture can ever satisfy that (a
 * fixture record can never certify, by construction). PRG back to the
 * detail page with the honest reason.
 */
export function demoMirrorRunHandler(
  demoId: string,
  redirect: (location: string) => HandlerResultLike,
): HandlerResultLike {
  const entry = defaultDemoEntries().find((candidate) => candidate.demoId === demoId) ?? null;
  if (entry === null) {
    return redirect(`/console/demos?error=unknown-demo`);
  }
  const resolution = resolveDemoMirrorEntry(entry, recordOf(entry.evidenceRecordId));
  const reason =
    resolution.kind === "available"
      ? resolution.projection.runAvailability.available
        ? "certified"
        : resolution.projection.runAvailability.reason
      : "The bound evidence record could not be resolved — no run is possible.";
  const encoded = encodeURIComponent(reason.slice(0, 300));
  return redirect(`/console/demos/${encodeURIComponent(demoId)}?run=${encoded}`);
}

/** The minimal handler-result shape the run handler needs (the http kernel's own). */
export interface HandlerResultLike {
  readonly status: number;
  readonly location?: string;
  readonly html?: string;
}

/** The run-initiation notice rendered on the detail page (query-param state, M24). */
export function demoMirrorRunNotice(runParam: string | null): string {
  if (runParam === null || runParam.length === 0) {
    return "";
  }
  const certified = runParam === "certified";
  if (certified) {
    return `<div class="state state-empty"><p class="state-title">Run initiated</p><p class="state-body">The certified run started — its live progress renders below when the run's events begin flowing.</p></div>`;
  }
  return `<div class="state state-error"><p class="state-title">Run refused — no certified integration path</p><p class="state-body">${esc(runParam)}</p></div>`;
}

/** The fixture record ids the surface is currently bound to (evidence transparency). */
export function demoMirrorBoundRecordIds(): readonly string[] {
  return FIXTURE_EVIDENCE_RECORDS.map((record) => record.recordId);
}

/** The specific fixture records (test/evidence seam — same objects the pages render). */
export function demoMirrorFixtureRecords(): readonly CompatibilityEvidenceRecord[] {
  return [EXAMPLE_CODING_ASSISTANT_RECORD, EXAMPLE_RAG_KNOWLEDGE_APP_RECORD];
}
