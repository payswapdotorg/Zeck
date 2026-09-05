/**
 * Zeck dashboard pages (WORK-033, re-homed on the WORK-035 foundation).
 *
 * The route map of the accepted UX implementation plan, preserved and
 * re-organized under the v2 information architecture. Every page is a
 * live projection through the SDK client; the ONLY mutations are
 * `createExecution` and `cancelExecution`, both through that client.
 * Surfaces the public API does not expose render honest unavailable
 * states (never fabricated data). Form state flows through hidden
 * fields and query params — there is no server-side session state
 * (M24).
 *
 * WORK-035: every page composes the shared foundation — pageHead (the
 * breadcrumb + contextual title + primary-action treatment), the state
 * primitives, the attention vocabulary, the disclosure primitives and
 * the mode-aware shell — instead of defining its own shell semantics
 * (AC10).
 */

import {
  type AgentSummary,
  type ArtifactReference,
  type Execution,
  type ExecutionEvent,
  type ExecutionResult,
  type VerificationResult,
  ZeckApiError,
  type ZeckClient,
} from "../../sdk";
import { attentionArea, attentionSummary } from "./attention";
import { CLIENT_SCRIPT } from "./client";
import {
  distinctionList,
  esc,
  executionHeader,
  glanceGrid,
  keyValueTable,
  longRunningWorkloadSection,
  progressTimeline,
  resultSurface,
  statusBadge,
  trainingStateList,
  verificationSummary,
  whyPanel,
} from "./components";
import {
  type AuditLedgerRow,
  accountingDetailDisclosure,
  auditLedgerSection,
  blockedExplanation,
  connectionsSection,
  controlFamiliesTable,
  createBlockedExplanation,
  environmentsSection,
  learningDistinctionSection,
  policyCompositionDisclosure,
  recommendationDispositionList,
  recommendationFamiliesSection,
  spendRunsTable,
  spendSummarySection,
  teamSection,
} from "./controls";
import { advancedDisclosure } from "./disclosure";
import {
  assetResult,
  type HandlerResult,
  type HttpContext,
  htmlResult,
  htmlStatusResult,
  type RouteDefinition,
  redirectResult,
  serializeCookie,
} from "./http";
import { deploymentSessionExecutionSection, inspectionPanel, modalitySections } from "./inspection";
import { type ExperienceMode, modeCookieHeader, modeOf } from "./modes";
import {
  type AgentSelectionFact,
  APPEARANCE_COOKIE,
  addRecent,
  agentGlanceFacts,
  agentSelectionFacts,
  agentSessionFactsOf,
  approvalQueueFacts,
  buildExecutionRequest,
  buildWorkloadRequest,
  chronologicalEvents,
  competenceDetailFacts,
  competenceDiscoveryFacts,
  completionExplainerRows,
  computerUseFactsOf,
  consumesArtifact,
  currentStageLabel,
  DEPLOYMENT_EXECUTION_DISTINCTION,
  deploymentGlanceFacts,
  deriveAttention,
  deriveTrustAxes,
  deriveVerificationChip,
  deriveWorkloadFacts,
  durationMs,
  economicFactsOf,
  edgeFactsOf,
  environmentFacts,
  evaluationStatusRows,
  eventStageLabel,
  executionTitle,
  inputArtifactRefsOf,
  isTerminal,
  looksLikeExecutionId,
  mediaFactsOf,
  type PolicyDenialFact,
  parseAttachmentRefs,
  parseRecents,
  planningDecisionOf,
  policyDenialOf,
  providerCategoryFacts,
  QUALITY_OPTIONS,
  RECENTS_COOKIE,
  type RunSpendFact,
  redactSecretShaped,
  runSpendFacts,
  safeTaskPairs,
  serializeRecents,
  sumMicroUsd,
  trainingFactsOf,
  validateExecutionForm,
  validateWorkloadForm,
  WORKLOAD_FORM_KEYS,
} from "./projection";
import { type Appearance, type AppShellInput, appShell, navIndex, pageHead } from "./shell";
import { confirmationCard, emptyState, errorState, unavailableState } from "./states";
import {
  artifactMetadataTable,
  artifactParentLineage,
  artifactUsageReferences,
  artifactVerificationReferences,
  contextTraversal,
  evidenceRefLink,
  TRUST_NOTE,
  trustAxesTable,
  trustAxisLabel,
  trustSummarySection,
} from "./trust";

const RECENTS_NOTE =
  "recently opened in this browser — navigation only; every view reads live through the governed API";

// ---------------------------------------------------------------------------
// Shared page helpers
// ---------------------------------------------------------------------------

function appearanceOf(cookies: Readonly<Record<string, string>>): Appearance {
  const value = cookies[APPEARANCE_COOKIE];
  return value === "light" || value === "dark" ? value : "system";
}

function page(
  input: Omit<AppShellInput, "appearance" | "mode">,
  ctx: HttpContext,
  options: { setCookies?: readonly string[] } = {},
): HandlerResult {
  return htmlResult(
    appShell({
      ...input,
      appearance: appearanceOf(ctx.cookies),
      mode: modeOf(ctx.cookies),
      returnTo: ctx.path,
    }),
    options,
  );
}

function recentsCookieHeader(ids: readonly string[]): string {
  return serializeCookie(RECENTS_COOKIE, serializeRecents(ids), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  });
}

function appearanceCookieHeader(mode: Appearance): string {
  return serializeCookie(APPEARANCE_COOKIE, mode, {
    path: "/",
    maxAge: 31_536_000,
    sameSite: "Lax",
  });
}

interface RecentsView {
  readonly executions: readonly Execution[];
  readonly survivingIds: readonly string[];
  readonly pruned: boolean;
}

/** Live re-read of the recents ids; ids whose live read 404s are dropped. */
async function readRecentExecutions(
  client: ZeckClient,
  ids: readonly string[],
): Promise<RecentsView> {
  const executions: Execution[] = [];
  let pruned = false;
  for (const id of ids) {
    try {
      executions.push(await client.getExecution(id));
    } catch (error) {
      if (error instanceof ZeckApiError && error.status === 404) {
        pruned = true;
        continue;
      }
      throw error;
    }
  }
  return { executions, survivingIds: executions.map((execution) => execution.id), pruned };
}

function lookupForm(): string {
  return `<form method="get" action="/executions" class="card">
  <div class="form-field">
    <label for="lookup-id">Look up an execution by id</label>
    <input id="lookup-id" name="id" required placeholder="execution id">
    <p class="form-hint">The public API exposes no execution listing route; executions are opened by id.</p>
  </div>
  <div class="form-actions"><button type="submit">Open execution</button></div>
</form>`;
}

function runsList(executions: readonly Execution[], emptyText: string): string {
  if (executions.length === 0) {
    return emptyState("Nothing here yet", emptyText);
  }
  const rows = executions
    .map(
      (execution) => `<li>
  <div class="run-line">
    <a class="run-title" href="/runs/${encodeURIComponent(execution.id)}">${esc(
      executionTitle(execution.task, execution.id),
    )}</a>
    ${statusBadge(execution.status)}
    ${isTerminal(execution.status) ? "" : `<span class="muted">${esc(currentStageLabel(execution.status))}</span>`}
  </div>
  <p class="muted mono">${esc(execution.id)}</p>
</li>`,
    )
    .join("\n  ");
  return `<ul class="runs-list">${rows}</ul>`;
}

// ---------------------------------------------------------------------------
// Home (the "Now" surface — AC1)
// ---------------------------------------------------------------------------

function suggestedActions(): string {
  return `<div class="suggested">
  <a href="/build/execution?outcome=${encodeURIComponent(
    "Analyze these files and summarize the findings",
  )}">Analyze files</a>
  <a href="/build/agent">Build an agent</a>
  <a href="/build/workload">Run a workload</a>
  <a href="/runs">Review a result</a>
</div>`;
}

/**
 * WORK-036 AC2: the secondary composer affordances — attachments (live:
 * input artifact references on the create contract), saved competences
 * and templates (honest not-exposed states, never fabricated pickers).
 * No provider/model selection exists anywhere in the composer.
 */
function composerSecondaryAffordances(): string {
  return `<details class="composer-secondary">
  <summary>Attachments, competences and templates</summary>
  <div class="form-field">
    <label for="home-attachments">Attach input artifacts (optional)</label>
    <textarea id="home-attachments" name="attachments" rows="2" placeholder="one artifact reference per line — optional"></textarea>
    <p class="form-hint">Input artifact references Zeck's plan can build on. Zeck owns the route — no provider, model or connection is selected here.</p>
  </div>
  <p class="composer-affordance"><a href="/assets/competences">Saved competences</a> — not exposed by the public API yet; when the competence authority ships, its facts will feed this composer.</p>
  <p class="composer-affordance">Templates — not exposed by the public API yet; a governed template surface will pre-fill this composer without changing the create contract.</p>
</details>`;
}

function homeOutcomeForm(idempotencyKey: string): string {
  return `<form class="flow card" method="get" action="/build/execution">
  <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
  <div class="form-field">
    <label for="home-outcome">What would you like Zeck to accomplish?</label>
    <textarea id="home-outcome" name="outcome" placeholder="Describe the outcome — Zeck plans, executes and verifies it under policy"></textarea>
  </div>
  ${composerSecondaryAffordances()}
  <div class="form-field">
    <label for="home-application">Application id</label>
    <input id="home-application" name="applicationId" placeholder="00000000-0000-7000-8000-0000000000aa">
    <p class="form-hint">The governed application scope the execution (and any spend) belongs to.</p>
  </div>
  <div class="form-actions"><button type="submit" class="primary">Plan this execution</button></div>
</form>
${suggestedActions()}`;
}

async function homePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const attention = deriveAttention(recents.executions);
  const active = recents.executions.filter(
    (execution) => !isTerminal(execution.status) && execution.status !== "FAILED",
  );
  const terminal = recents.executions.filter((execution) => isTerminal(execution.status));
  const content = `${pageHead({
    title: "Home",
    path: "/",
    primaryActionHtml: '<a class="button-link primary" href="/build/execution">Start new work</a>',
  })}
${homeOutcomeForm(`dash-${crypto.randomUUID()}`)}
<h2>Needs your attention</h2>
${
  attention.length === 0
    ? emptyState(
        "No attention items",
        "No executions opened in this browser need a decision or failed — start one above, or look one up by id.",
      )
    : `<p class="muted">${esc(RECENTS_NOTE)}</p>
${attentionArea(attention)}`
}
<h2>Happening now</h2>
${
  active.length === 0
    ? emptyState(
        "No active executions",
        "No executions opened in this browser are running — start one above, or look one up by id.",
      )
    : `<p class="muted">${esc(RECENTS_NOTE)}</p>
${runsList(active, "")}`
}
<h2>Recent results</h2>
${
  terminal.length === 0
    ? emptyState(
        "No recent outcomes",
        "No executions opened in this browser have finished yet — start one above, or look one up by id.",
      )
    : `<p class="muted">${esc(RECENTS_NOTE)}</p>
${runsList(terminal, "")}`
}
<h2>Find an execution</h2>
${lookupForm()}`;
  return page({ title: "Zeck — Home", activePath: "/", mainContent: content, attention }, ctx, {
    setCookies,
  });
}

// ---------------------------------------------------------------------------
// Build surfaces (AC4)
// ---------------------------------------------------------------------------

async function buildOverviewPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `${pageHead({
    title: "Build",
    path: "/build",
    primaryActionHtml:
      '<a class="button-link primary" href="/build/execution">Start an execution</a>',
  })}
<p>Start from the outcome you want. Zeck proposes how to get there; detailed configuration comes after the proposal.</p>
<div class="tiles">
  <section class="tile">
    <h3><a href="/build/execution">Execution</a></h3>
    <p>Describe an outcome; Zeck plans the route, executes under policy and records the evidence.</p>
    <p class="muted">Live today — the propose-and-review flow.</p>
  </section>
  <section class="tile">
    <h3><a href="/build/agent">Agent</a></h3>
    <p>Propose a reusable execution system with guardrails and verification.</p>
    <p class="muted">Proposal flow live; committing the design is not exposed by the public API — the agents surface is read-only.</p>
  </section>
  <section class="tile">
    <h3><a href="/build/workload">Workload / Training / Batch</a></h3>
    <p>Training and batch compute as governed executions with budget and checkpoints.</p>
    <p class="muted">Live today — outcome-first creation through the governed execution authority; the workload/training authorities' own states are not public.</p>
  </section>
  <section class="tile">
    <h3><a href="/build/deployment">Deployment</a></h3>
    <p>Persistent availability of an agent or program — distinct from individual executions.</p>
    <p class="muted">Not exposed by the public API yet; the proposal flow states what a deployment is and is not.</p>
  </section>
</div>`;
  return page({ title: "Zeck — Build", activePath: "/build", mainContent: content }, ctx);
}

function executionFormField(
  id: string,
  label: string,
  input: string,
  hint?: string,
  error?: string,
): string {
  const describedBy = error === undefined ? "" : ` aria-describedby="${id}-error"`;
  return `<div class="form-field">
  <label for="${id}"${describedBy}>${esc(label)}</label>
  ${input}
  ${hint === undefined ? "" : `<p class="form-hint">${esc(hint)}</p>`}
  ${error === undefined ? "" : `<p class="field-error" id="${id}-error">${esc(error)}</p>`}
</div>`;
}

function executionFormFields(
  values: Record<string, string>,
  errors: Record<string, string | undefined>,
): string {
  return [
    executionFormField(
      "f-application",
      "Application id",
      `<input id="f-application" name="applicationId" value="${esc(
        values.applicationId ?? "",
      )}" required>`,
      "The governed application scope the execution (and any spend) belongs to.",
      errors.applicationId,
    ),
    executionFormField(
      "f-outcome",
      "What would you like Zeck to accomplish?",
      `<textarea id="f-outcome" name="outcome" required>${esc(values.outcome ?? "")}</textarea>`,
      "The outcome, in your words. Zeck owns planning, routing, execution and verification.",
      errors.outcome,
    ),
    executionFormField(
      "f-attachments",
      "Attach input artifacts (optional)",
      `<textarea id="f-attachments" name="attachments" rows="2" placeholder="one artifact reference per line — optional">${esc(
        values.attachments ?? "",
      )}</textarea>`,
      "Input artifact references the plan can build on. No provider, model or connection is selected here — Zeck owns the route.",
      errors.attachments,
    ),
    executionFormField(
      "f-spend",
      "Spend limit (dollars, optional)",
      `<input id="f-spend" name="spendLimitDollars" value="${esc(
        values.spendLimitDollars ?? "",
      )}" inputmode="decimal" placeholder="10.50">`,
      "Sent to the platform as an integer micro-USD constraint.",
      errors.spendLimitDollars,
    ),
    executionFormField(
      "f-quality",
      "Quality target (optional)",
      `<select id="f-quality" name="quality">${QUALITY_OPTIONS.map(
        ([value, label]) =>
          `<option value="${esc(value)}"${(values.quality ?? "") === value ? " selected" : ""}>${esc(
            label,
          )}</option>`,
      ).join("")}</select>`,
      "A minimum quality target for the route.",
      errors.quality,
    ),
    executionFormField(
      "f-latency",
      "Latency limit (seconds, optional)",
      `<input id="f-latency" name="latencySeconds" value="${esc(
        values.latencySeconds ?? "",
      )}" inputmode="numeric" placeholder="120">`,
      "Maximum end-to-end latency in whole seconds.",
      errors.latencySeconds,
    ),
    executionFormField(
      "f-environment",
      "Compute environment (optional)",
      `<input id="f-environment" name="environmentId" value="${esc(values.environmentId ?? "")}">`,
      "Leave empty to use the default compute environment.",
      errors.environmentId,
    ),
    executionFormField(
      "f-user",
      "End user (optional)",
      `<input id="f-user" name="userId" value="${esc(values.userId ?? "")}">`,
      "The end user the execution and any spend is attributed to.",
      errors.userId,
    ),
  ].join("\n");
}

const FORM_KEYS: readonly string[] = [
  "applicationId",
  "environmentId",
  "outcome",
  "attachments",
  "spendLimitDollars",
  "quality",
  "latencySeconds",
  "userId",
  "idempotencyKey",
];

function constraintSummary(values: Record<string, string>): string[] {
  const lines: string[] = [];
  if ((values.spendLimitDollars ?? "").length > 0) {
    lines.push(`Spend limit: $${esc(values.spendLimitDollars ?? "")}`);
  }
  if ((values.quality ?? "").length > 0) {
    lines.push(`Quality target: ${esc(values.quality ?? "")}`);
  }
  if ((values.latencySeconds ?? "").length > 0) {
    lines.push(`Latency limit: ${esc(values.latencySeconds ?? "")} seconds`);
  }
  return lines;
}

/**
 * WORK-036 AC3: the proposed-approach envelope — everything the user can
 * understand BEFORE running: purpose, estimated cost/time (the declared
 * envelope — the platform exposes no pre-run estimate, so none is
 * fabricated), the permission/risk envelope (in user language, honest
 * about what the platform decides) and the proposed verification
 * approach (platform-recorded results, honest about pre-run detail).
 */
function proposedApproachEnvelope(values: Record<string, string>): string {
  const constraints = constraintSummary(values);
  const artifactRefs = (values.attachments ?? "").trim().length > 0;
  const costTime =
    constraints.length === 0
      ? '<p class="muted">No explicit cost or time envelope was set — Zeck will route within the governing policy, and the settled cost and duration are recorded per execution.</p>'
      : `<ul>${constraints.map((line) => `<li>${line}</li>`).join("")}</ul>
  <p class="muted">These are the limits you set, not platform estimates — the platform exposes no pre-run cost or time estimate, so none is shown. The settled cost and duration appear on the execution's header facts.</p>`;
  return `<div class="card review-envelope">
  <h2>Proposed approach</h2>
  <h3>Purpose</h3>
  <p>${esc(values.outcome ?? "")}</p>
  <h3>Estimated cost and time</h3>
  ${costTime}
  <h3>Permission and risk envelope</h3>
  <p>This request selects no provider, model, rail, connection or agent — the frozen create contract forbids provider selection, and Zeck owns the route. Policy admission is decided platform-side at dispatch: if policy denies the request, the denial is surfaced honestly on the execution (never silently retried). External side effects, where the governing policy requires approval, surface as attention items before they proceed.</p>
  <h3>Proposed verification approach</h3>
  <p>Zeck records verification results per execution — they appear on the Result view's trust summary and the Evidence view. The verification approach itself is chosen by the platform and is not exposed before the run; the dashboard never invents a confidence claim.</p>
  <h3>Inputs and scope</h3>
  ${keyValueTable([
    ["Application", values.applicationId ?? ""],
    [
      "Compute environment",
      (values.environmentId ?? "").length > 0 ? (values.environmentId ?? "") : "default",
    ],
    ["End user", (values.userId ?? "").length > 0 ? (values.userId ?? "") : "—"],
    [
      "Input artifacts",
      artifactRefs
        ? "attached — the references below are sent on the create request"
        : "none attached",
    ],
  ])}
  ${
    artifactRefs
      ? `<p class="muted mono">${esc((values.attachments ?? "").trim().replaceAll("\n", " · "))}</p>`
      : ""
  }
</div>`;
}

/**
 * WORK-036 AC9: the hidden field pairs the Run commitment form carries
 * (the same FORM_KEYS the composer round-trips, idempotency key included).
 */
function commitmentHiddenFields(
  values: Record<string, string>,
): readonly (readonly [string, string])[] {
  return FORM_KEYS.filter((key) => key !== "idempotencyKey" || (values[key] ?? "").length > 0).map(
    (key) => [key, values[key] ?? ""] as const,
  );
}

/**
 * WORK-036 AC9: the consequence/commitment block immediately before Run —
 * the five pre-commit consequence facts (what will happen, affected
 * resource, authorization requirement, cost estimate status,
 * reversibility), each a public-contract fact or an honest absence,
 * rendered through the WORK-035 confirmation primitive (never a parallel
 * confirmation pattern). The confirm button is Run itself; "Not now"
 * returns to editing the same details.
 */
function runCommitmentCard(
  values: Record<string, string>,
  idempotencyKey: string,
  confirmLabel: string,
): string {
  const environment =
    (values.environmentId ?? "").length > 0
      ? `environment ${values.environmentId ?? ""}`
      : "the default environment";
  const userId = (values.userId ?? "").length > 0 ? (values.userId ?? "") : null;
  const artifactRefs = parseAttachmentRefs(values.attachments ?? "") ?? [];
  const spendLimit = (values.spendLimitDollars ?? "").trim();
  const costStatus = `No pre-run estimate — the platform's public contract exposes none, so none is shown; the settled cost is recorded per execution on the run's header facts.${
    spendLimit.length > 0
      ? ` Your declared spend limit ($${spendLimit}) is enforced as the request's cost constraint.`
      : ""
  }`;
  return confirmationCard({
    title: "Run this work?",
    consequence:
      "Run submits the governed create request: exactly one execution is created for this outcome, Zeck plans the route and executes the work within the governing policy, and the events, verification results, output artifacts and settled cost are recorded platform-side — you follow the run on its execution page.",
    affected: `A governed execution record in application ${values.applicationId ?? ""} (${environment})${
      userId === null ? "" : `, attributed to end user ${userId}`
    }${
      artifactRefs.length > 0
        ? `, with ${artifactRefs.length} attached input artifact${artifactRefs.length === 1 ? "" : "s"} read as inputs`
        : ""
    }. External side effects, if any, are admitted by policy and surface as attention before they proceed.`,
    cost: costStatus,
    whyAllowed:
      "The create request is valid against the frozen create contract — it selects no provider, model, rail, connection or agent (selection is forbidden; the platform plans the route), and policy admission is decided platform-side at dispatch: a denial is surfaced on the execution, never silently retried.",
    reversible: false,
    reversibleDetail:
      "No — a committed execution cannot be undone through the public contract. The governed stop is Cancel (its own consequence preview); work already performed and its evidence stay recorded and inspectable.",
    approvalNote:
      "No user pre-approval is part of the public create contract — the platform's policy admission at dispatch is the authorization boundary. Where the governing policy requires approval for external side effects, they surface as waiting states before they proceed.",
    idempotencyNote: `The idempotency key ${idempotencyKey} is carried: reloading this review or submitting again converges on ONE execution rather than creating duplicates.`,
    hiddenFields: commitmentHiddenFields({ ...values, idempotencyKey }),
    confirmAction: "/build/execution",
    confirmLabel,
    cancelHref: editLink(values, idempotencyKey),
  });
}

function editLink(values: Record<string, string>, idempotencyKey: string): string {
  const params = new URLSearchParams();
  for (const key of FORM_KEYS) {
    params.set(key, values[key] ?? "");
  }
  params.set("edit", "1");
  params.set("idempotencyKey", idempotencyKey);
  return `/build/execution?${params.toString()}`;
}

async function buildExecutionPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const query: Record<string, string> = {};
  for (const key of [...FORM_KEYS, "edit"]) {
    const value = ctx.query.get(key);
    if (value !== null) {
      query[key] = value;
    }
  }
  const idempotencyKey =
    (query.idempotencyKey ?? "").length > 0
      ? (query.idempotencyKey ?? "")
      : `dash-${crypto.randomUUID()}`;
  const reviewable =
    (query.outcome ?? "").trim().length > 0 &&
    (query.applicationId ?? "").trim().length > 0 &&
    query.edit !== "1";
  if (!reviewable) {
    const content = `${pageHead({
      title: "Start an execution",
      path: "/build/execution",
      primaryActionHtml: '<a class="button-link" href="/command?q=examples">Command examples</a>',
    })}
<p>Describe the outcome first. Zeck proposes the plan; you review it before anything runs.</p>
<form class="flow card" method="get" action="/build/execution">
  <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
  ${executionFormFields(query, {})}
  <div class="form-actions"><button type="submit" class="primary">Review the proposal</button></div>
</form>`;
    return page(
      { title: "Zeck — Start an execution", activePath: "/build/execution", mainContent: content },
      ctx,
    );
  }
  const validation = validateExecutionForm(query);
  if (validation.values === null) {
    const content = `${pageHead({ title: "Start an execution", path: "/build/execution" })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The request could not be reviewed — fix the highlighted fields.</div>
<form class="flow card" method="get" action="/build/execution">
  <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
  ${executionFormFields(query, validation.errors)}
  <div class="form-actions"><button type="submit" class="primary">Review the proposal</button></div>
</form>`;
    return page(
      { title: "Zeck — Start an execution", activePath: "/build/execution", mainContent: content },
      ctx,
    );
  }
  const content = `${pageHead({
    title: "Review the proposed execution",
    path: "/build/execution",
    primaryActionHtml: `<a class="button-link" href="${esc(editLink(query, idempotencyKey))}">Edit these details</a>`,
  })}
${proposedApproachEnvelope(query)}
${runCommitmentCard(query, idempotencyKey, "Run")}`;
  return page(
    {
      title: "Zeck — Review the proposed execution",
      activePath: "/build/execution",
      mainContent: content,
    },
    ctx,
  );
}

async function createExecutionHandler(
  client: ZeckClient,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const validation = validateExecutionForm(ctx.form);
  const idempotencyKey = (ctx.form.idempotencyKey ?? "").trim();
  if (validation.values === null || idempotencyKey.length === 0) {
    const errors: Record<string, string | undefined> = { ...validation.errors };
    if (idempotencyKey.length === 0) {
      errors.outcome = "The form state was lost — fill the outcome again and resubmit.";
    }
    const content = `${pageHead({ title: "Start an execution", path: "/build/execution" })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The request could not be submitted — fix the highlighted fields.</div>
<form class="flow card" method="get" action="/build/execution">
  <input type="hidden" name="idempotencyKey" value="${esc(
    idempotencyKey.length > 0 ? idempotencyKey : `dash-${crypto.randomUUID()}`,
  )}">
  ${executionFormFields(ctx.form, errors)}
  <div class="form-actions"><button type="submit" class="primary">Review the proposal</button></div>
</form>`;
    return htmlStatusResult(
      422,
      appShell({
        title: "Zeck — Start an execution",
        activePath: "/build/execution",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  try {
    const request = buildExecutionRequest(validation.values);
    const { receipt } = await client.createExecution(request, idempotencyKey);
    return redirectResult(`/runs/${encodeURIComponent(receipt.executionId)}`);
  } catch (error) {
    if (error instanceof ZeckApiError && error.status < 500) {
      // WORK-039 AC2/AC8: a policy-boundary refusal renders the blocked
      // vocabulary (the platform's message as the controlling rule, the
      // authorization boundary stated) — the same explanation a blocked
      // run's page carries, before any retry commitment.
      const policyBoundary =
        error.body.code === "POLICY_DENIED" || error.body.code === "BUDGET_EXCEEDED"
          ? `\n${createBlockedExplanation(error.body.code, error.body.message)}`
          : "";
      const content = `${pageHead({
        title: "Review the proposed execution",
        path: "/build/execution",
        primaryActionHtml: `<a class="button-link" href="${esc(editLink(ctx.form, idempotencyKey))}">Edit these details</a>`,
      })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The platform rejected this request: ${esc(
        error.body.message,
      )} (${esc(error.body.code)})</div>
${policyBoundary}
${proposedApproachEnvelope(ctx.form)}
${runCommitmentCard(ctx.form, idempotencyKey, "Try again")}`;
      return htmlStatusResult(
        422,
        appShell({
          title: "Zeck — Review the proposed execution",
          activePath: "/build/execution",
          mainContent: content,
          appearance: appearanceOf(ctx.cookies),
          mode: modeOf(ctx.cookies),
          returnTo: ctx.path,
        }),
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Build: agent proposal (AC2), workload creation (AC6) and deployment
// proposal (AC1/AC4/AC5) — outcome-first, honest terminal states
// ---------------------------------------------------------------------------

/**
 * WORK-037 AC2: the agent proposal descriptors — outcome-level inputs the
 * user describes in their own words. No provider, model, rail or
 * connection field exists anywhere (the frozen create contract forbids
 * provider selection; detailed configuration is a disclosure, never a
 * prerequisite).
 */
function agentProposalForm(values: Record<string, string>): string {
  return `<form class="flow card" method="get" action="/build/agent">
  <div class="form-field">
    <label for="agent-purpose">What are you building?</label>
    <textarea id="agent-purpose" name="purpose" placeholder="A support agent that handles incoming tickets and escalates billing disputes.">${esc(
      values.purpose ?? "",
    )}</textarea>
    <p class="form-hint">The purpose in your words — the design comes back as a readable proposal.</p>
  </div>
  <div class="form-field">
    <label for="agent-capabilities">What must it be able to do? (optional)</label>
    <textarea id="agent-capabilities" name="capabilities" rows="3" placeholder="Triage incoming tickets, look up orders, draft replies.">${esc(
      values.capabilities ?? "",
    )}</textarea>
  </div>
  <div class="form-field">
    <label for="agent-integrations">What must it connect to? (optional)</label>
    <textarea id="agent-integrations" name="integrations" rows="2" placeholder="The ticket system and the orders database.">${esc(
      values.integrations ?? "",
    )}</textarea>
    <p class="form-hint">Connections are governed server-side (BYOK); no credential is ever entered or rendered here.</p>
  </div>
  <div class="form-field">
    <label for="agent-guardrails">What limits apply? (optional)</label>
    <textarea id="agent-guardrails" name="guardrails" rows="2" placeholder="Escalate billing disputes to a human; no external side effects without approval.">${esc(
      values.guardrails ?? "",
    )}</textarea>
  </div>
  <div class="form-field">
    <label for="agent-verification">What checks must it pass? (optional)</label>
    <textarea id="agent-verification" name="verification" rows="2" placeholder="Reply drafts match the escalation policy.">${esc(
      values.verification ?? "",
    )}</textarea>
  </div>
  <div class="form-actions"><button type="submit" class="primary">Review the proposed design</button></div>
</form>`;
}

function descriptorOrAbsent(value: string, what: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? `Not described yet — ${what}.` : trimmed;
}

/**
 * WORK-037 AC2: the human-readable agent proposal — six sections
 * (purpose, capabilities, integrations, guardrails, verification,
 * expected cost), each the user's stated intent plus the honest platform
 * fact, BEFORE any detailed configuration. The proposal is a readable
 * summary; committing it is honestly unavailable (no public
 * agent-authoring route).
 */
function agentProposalEnvelope(values: Record<string, string>): string {
  return `<div class="card review-envelope">
  <h2>Proposed agent design</h2>
  <h3>Purpose</h3>
  <p>${esc(descriptorOrAbsent(values.purpose ?? "", "describe what you are building"))}</p>
  <h3>Capabilities</h3>
  <p>${esc(descriptorOrAbsent(values.capabilities ?? "", "describe what the agent must be able to do"))}</p>
  <p class="muted">Capabilities are governed platform-side; the public contract carries no per-agent capability facts to pre-fill here.</p>
  <h3>Integrations</h3>
  <p>${esc(descriptorOrAbsent(values.integrations ?? "", "describe what it must connect to"))}</p>
  <p class="muted">Connections are governed server-side with your own credentials (BYOK) — no credential is ever entered, stored or rendered in this dashboard.</p>
  <h3>Guardrails</h3>
  <p>${esc(descriptorOrAbsent(values.guardrails ?? "", "describe the limits and approval requirements"))}</p>
  <p class="muted">Guardrails are enforced by the governing policy at dispatch; approval-gated side effects surface as waiting states on each execution.</p>
  <h3>Verification</h3>
  <p>${esc(descriptorOrAbsent(values.verification ?? "", "describe the checks the agent must pass"))}</p>
  <p class="muted">Verification results are recorded per execution; the public contract exposes no per-agent-definition verification approach before a run.</p>
  <h3>Expected cost</h3>
  <p>No pre-creation estimate exists — the public contract exposes none, so none is shown. Costs are recorded per execution once the agent runs, on each run's header facts.</p>
</div>`;
}

async function buildAgentPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const values: Record<string, string> = {
    purpose: ctx.query.get("purpose") ?? "",
    capabilities: ctx.query.get("capabilities") ?? "",
    integrations: ctx.query.get("integrations") ?? "",
    guardrails: ctx.query.get("guardrails") ?? "",
    verification: ctx.query.get("verification") ?? "",
  };
  const purpose = values.purpose ?? "";
  const content = `${pageHead({
    title: "Build an agent",
    path: "/build/agent",
    primaryActionHtml: '<a class="button-link" href="/agents">View the agent inventory</a>',
  })}
<p>Agents are reusable execution systems. Start from the purpose; the design comes back as a readable proposal you review before any detailed configuration.</p>
${agentProposalForm(values)}
${
  purpose.trim().length === 0
    ? ""
    : agentProposalEnvelope(values) +
      unavailableState(
        "Committing this design",
        "Agent creation is not exposed by the public API — no governed agent-authoring route exists, so this proposal cannot be committed from here (the dashboard renders no create action for it). The agents surface is a read-only projection; create agents through your governed application path.",
        "a public agent-authoring authority whose create route this proposal will formalize through",
      ) +
      advancedDisclosure(
        "Advanced configuration (the governed authoring vocabulary)",
        `<p class="muted">Detailed configuration is a disclosure, never a prerequisite. The read-side facts the public agents projection DOES carry today: versioned definitions with a definition digest, a validation state per version (${["pending", "validated", "invalid"].join(" / ")}), and a recorded selection history (promotion or rollback of a version, with who selected it and when). When agent authoring ships as a public authority, these are the facts your accepted proposal will produce — versions, validation, and governed selections.</p>`,
      )
}
<p><a href="/agents">View the agent inventory (read-only)</a> · <a href="/build">Back to Build</a></p>`;
  return page(
    { title: "Zeck — Build an agent", activePath: "/build/agent", mainContent: content },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Build: workload/training/batch creation — outcome-first, budget-visible,
// committed through the ONE governed execution create (AC6/AC7)
// ---------------------------------------------------------------------------

function workloadFormField(
  id: string,
  label: string,
  input: string,
  hint?: string,
  error?: string,
): string {
  const describedBy = error === undefined ? "" : ` aria-describedby="${id}-error"`;
  return `<div class="form-field">
  <label for="${id}"${describedBy}>${esc(label)}</label>
  ${input}
  ${hint === undefined ? "" : `<p class="form-hint">${esc(hint)}</p>`}
  ${error === undefined ? "" : `<p class="field-error" id="${id}-error">${esc(error)}</p>`}
</div>`;
}

function workloadFormFields(
  values: Record<string, string>,
  errors: Record<string, string | undefined>,
): string {
  return [
    workloadFormField(
      "wl-application",
      "Application id",
      `<input id="wl-application" name="applicationId" value="${esc(
        values.applicationId ?? "",
      )}" required>`,
      "The governed application scope the workload (and any spend) belongs to.",
      errors.applicationId,
    ),
    workloadFormField(
      "wl-purpose",
      "What should the workload do?",
      `<textarea id="wl-purpose" name="purpose" required>${esc(values.purpose ?? "")}</textarea>`,
      "Training, batch compute or any long-running job — described as the outcome, in your words.",
      errors.purpose,
    ),
    workloadFormField(
      "wl-budget",
      "Budget (dollars, optional)",
      `<input id="wl-budget" name="budgetDollars" value="${esc(
        values.budgetDollars ?? "",
      )}" inputmode="decimal" placeholder="50.00">`,
      "Sent to the platform as an integer micro-USD cost constraint — the budget the workload must stay within.",
      errors.budgetDollars,
    ),
    workloadFormField(
      "wl-datasets",
      "Dataset artifacts (optional)",
      `<textarea id="wl-datasets" name="datasets" rows="2" placeholder="one artifact reference per line — optional">${esc(
        values.datasets ?? "",
      )}</textarea>`,
      "Input artifact references the plan can build on (datasets, source data). No provider, model or connection is selected here.",
      errors.datasets,
    ),
    workloadFormField(
      "wl-user",
      "End user (optional)",
      `<input id="wl-user" name="userId" value="${esc(values.userId ?? "")}">`,
      "The end user the workload and any spend is attributed to.",
      errors.userId,
    ),
  ].join("\n");
}

/**
 * WORK-037 AC6: the workload proposal — purpose, budget and cost (the
 * declared budget as the enforced constraint; the honest no-pre-run
 * estimate), inputs, and what this creates (ONE governed execution — the
 * honest statement that the workload/training authorities' own states are
 * not public). AC7: the completion explainer — the four distinct states.
 */
function workloadProposalEnvelope(values: Record<string, string>): string {
  const datasetRefs = parseAttachmentRefs(values.datasets ?? "") ?? [];
  const budget = (values.budgetDollars ?? "").trim();
  return `<div class="card review-envelope">
  <h2>Proposed workload</h2>
  <h3>Purpose</h3>
  <p>${esc(values.purpose ?? "")}</p>
  <h3>Budget and cost</h3>
  ${
    budget.length === 0
      ? `<p class="muted">No budget was set — the workload runs within the governing policy. You can set a budget to bound it.</p>`
      : `<ul><li>Declared budget: $${esc(budget)} — sent as the request's integer micro-USD cost constraint and enforced by the platform.</li></ul>`
  }
  <p class="muted">The platform exposes no pre-run cost or time estimate, so none is shown. Costs are recorded per execution and visible throughout the lifecycle — on the run's header facts and the long-running workload view (when the platform records checkpoints or recovery events).</p>
  <h3>Inputs</h3>
  ${keyValueTable([
    ["Application", values.applicationId ?? ""],
    [
      "Dataset artifacts",
      datasetRefs.length > 0
        ? `attached — ${datasetRefs.length} reference${datasetRefs.length === 1 ? "" : "s"} sent on the create request`
        : "none attached",
    ],
    ["End user", (values.userId ?? "").length > 0 ? (values.userId ?? "") : "—"],
  ])}
  <h3>What this creates</h3>
  <p>Exactly one governed execution. A workload — training, batch compute or any long-running job — is governed work through the execution authority: the run page is its lifecycle view (progress, checkpoints, spend, recovery state). The workload and training authorities' own state machines (workload status, release gates) are not exposed by the public API; this surface never presents them.</p>
  <h3>What completion will mean</h3>
  ${trainingStateList(completionExplainerRows())}
</div>`;
}

function workloadEditLink(values: Record<string, string>, idempotencyKey: string): string {
  const params = new URLSearchParams();
  for (const key of WORKLOAD_FORM_KEYS) {
    params.set(key, values[key] ?? "");
  }
  params.set("edit", "1");
  params.set("idempotencyKey", idempotencyKey);
  return `/build/workload?${params.toString()}`;
}

/**
 * WORK-037 AC6: the workload commitment — the full consequence block
 * immediately before Start, through the WORK-035 confirmationCard (the
 * same primitive and vocabulary as the execution commitment; the
 * workload-specific facts: the budget constraint, the dataset inputs).
 */
function workloadCommitmentCard(
  values: Record<string, string>,
  idempotencyKey: string,
  confirmLabel: string,
): string {
  const datasetRefs = parseAttachmentRefs(values.datasets ?? "") ?? [];
  const budget = (values.budgetDollars ?? "").trim();
  const userId = (values.userId ?? "").trim();
  const costStatus = `No pre-run estimate — the platform's public contract exposes none, so none is shown; the settled cost is recorded per execution on the run's header facts.${
    budget.length > 0
      ? ` Your declared budget ($${budget}) is enforced as the request's cost constraint.`
      : " No budget was set — spend stays within the governing policy."
  }`;
  return confirmationCard({
    title: "Start this workload?",
    consequence:
      "Start submits the governed create request: exactly one execution is created for this workload, Zeck plans the route and executes the work within the governing policy and the declared budget, and the events, checkpoints (when the platform records them), verification results, output artifacts and settled cost are recorded platform-side — you follow the workload on its run page.",
    affected: `A governed execution record in application ${values.applicationId ?? ""}${
      userId.length > 0 ? `, attributed to end user ${userId}` : ""
    }${
      datasetRefs.length > 0
        ? `, with ${datasetRefs.length} dataset artifact${datasetRefs.length === 1 ? "" : "s"} read as inputs`
        : ""
    }${
      budget.length > 0
        ? `, bounded by the declared budget ($${budget}) as the cost constraint`
        : ""
    }. External side effects, if any, are admitted by policy and surface as attention before they proceed.`,
    cost: costStatus,
    whyAllowed:
      "The create request is valid against the frozen create contract — it selects no provider, model, rail, connection or agent (selection is forbidden; the platform plans the route), and policy admission is decided platform-side at dispatch: a denial is surfaced on the execution, never silently retried.",
    reversible: false,
    reversibleDetail:
      "No — a committed execution cannot be undone through the public contract. The governed stop is Cancel (its own consequence preview); work already performed, its checkpoints and its evidence stay recorded and inspectable.",
    approvalNote:
      "No user pre-approval is part of the public create contract — the platform's policy admission at dispatch is the authorization boundary. Where the governing policy requires approval for external side effects, they surface as waiting states before they proceed.",
    idempotencyNote: `The idempotency key ${idempotencyKey} is carried: reloading this review or submitting again converges on ONE execution rather than creating duplicates.`,
    hiddenFields: WORKLOAD_FORM_KEYS.map(
      (key) => [key, key === "idempotencyKey" ? idempotencyKey : (values[key] ?? "")] as const,
    ),
    confirmAction: "/build/workload",
    confirmLabel,
    cancelHref: workloadEditLink(values, idempotencyKey),
  });
}

async function buildWorkloadPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const query: Record<string, string> = {};
  for (const key of [...WORKLOAD_FORM_KEYS, "edit"]) {
    const value = ctx.query.get(key);
    if (value !== null) {
      query[key] = value;
    }
  }
  const idempotencyKey =
    (query.idempotencyKey ?? "").length > 0
      ? (query.idempotencyKey ?? "")
      : `dash-${crypto.randomUUID()}`;
  const reviewable =
    (query.purpose ?? "").trim().length > 0 &&
    (query.applicationId ?? "").trim().length > 0 &&
    query.edit !== "1";
  if (!reviewable) {
    const content = `${pageHead({
      title: "Build a workload",
      path: "/build/workload",
      primaryActionHtml:
        '<a class="button-link" href="/build/execution">Run a one-off execution instead</a>',
    })}
<p>Training and batch compute are governed work in Zeck — budgeted, checkpointed and verified through the execution authority. Start from what the workload should accomplish.</p>
<form class="flow card" method="get" action="/build/workload">
  <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
  ${workloadFormFields(query, {})}
  <div class="form-actions"><button type="submit" class="primary">Review the proposal</button></div>
</form>`;
    return page(
      { title: "Zeck — Build a workload", activePath: "/build/workload", mainContent: content },
      ctx,
    );
  }
  const validation = validateWorkloadForm(query);
  if (validation.values === null) {
    const content = `${pageHead({ title: "Build a workload", path: "/build/workload" })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The request could not be reviewed — fix the highlighted fields.</div>
<form class="flow card" method="get" action="/build/workload">
  <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
  ${workloadFormFields(query, validation.errors)}
  <div class="form-actions"><button type="submit" class="primary">Review the proposal</button></div>
</form>`;
    return page(
      { title: "Zeck — Build a workload", activePath: "/build/workload", mainContent: content },
      ctx,
    );
  }
  const content = `${pageHead({
    title: "Review the proposed workload",
    path: "/build/workload",
    primaryActionHtml: `<a class="button-link" href="${esc(
      workloadEditLink(query, idempotencyKey),
    )}">Edit these details</a>`,
  })}
${workloadProposalEnvelope(query)}
${workloadCommitmentCard(query, idempotencyKey, "Start this workload")}`;
  return page(
    {
      title: "Zeck — Review the proposed workload",
      activePath: "/build/workload",
      mainContent: content,
    },
    ctx,
  );
}

/**
 * WORK-037: the workload create handler — the SECOND governed create
 * surface, through the SAME wire command as the execution create
 * (`client.createExecution` over POST /executions with an idempotency
 * key). The workload surface is presentation over the one execution
 * authority — never a second mutation authority.
 */
async function createWorkloadHandler(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const validation = validateWorkloadForm(ctx.form);
  const idempotencyKey = (ctx.form.idempotencyKey ?? "").trim();
  if (validation.values === null || idempotencyKey.length === 0) {
    const errors: Record<string, string | undefined> = { ...validation.errors };
    if (idempotencyKey.length === 0) {
      errors.purpose = "The form state was lost — fill the purpose again and resubmit.";
    }
    const content = `${pageHead({ title: "Build a workload", path: "/build/workload" })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The request could not be submitted — fix the highlighted fields.</div>
<form class="flow card" method="get" action="/build/workload">
  <input type="hidden" name="idempotencyKey" value="${esc(
    idempotencyKey.length > 0 ? idempotencyKey : `dash-${crypto.randomUUID()}`,
  )}">
  ${workloadFormFields(ctx.form, errors)}
  <div class="form-actions"><button type="submit" class="primary">Review the proposal</button></div>
</form>`;
    return htmlStatusResult(
      422,
      appShell({
        title: "Zeck — Build a workload",
        activePath: "/build/workload",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  try {
    const request = buildWorkloadRequest(validation.values);
    const { receipt } = await client.createExecution(request, idempotencyKey);
    return redirectResult(`/runs/${encodeURIComponent(receipt.executionId)}`);
  } catch (error) {
    if (error instanceof ZeckApiError && error.status < 500) {
      const content = `${pageHead({
        title: "Review the proposed workload",
        path: "/build/workload",
        primaryActionHtml: `<a class="button-link" href="${esc(
          workloadEditLink(ctx.form, idempotencyKey),
        )}">Edit these details</a>`,
      })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The platform rejected this request: ${esc(
        error.body.message,
      )} (${esc(error.body.code)})</div>
${workloadProposalEnvelope(ctx.form)}
${workloadCommitmentCard(ctx.form, idempotencyKey, "Try again")}`;
      return htmlStatusResult(
        422,
        appShell({
          title: "Zeck — Review the proposed workload",
          activePath: "/build/workload",
          mainContent: content,
          appearance: appearanceOf(ctx.cookies),
          mode: modeOf(ctx.cookies),
          returnTo: ctx.path,
        }),
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Build: deployment proposal (AC1/AC4/AC5) and the deployment surfaces —
// the availability/execution distinction, honest absences everywhere
// ---------------------------------------------------------------------------

async function buildDeploymentPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const purpose = ctx.query.get("purpose") ?? "";
  const proposal =
    purpose.trim().length === 0
      ? ""
      : `<div class="card review-envelope">
  <h2>Proposed deployment design</h2>
  <h3>What stays available</h3>
  <p>${esc(purpose)}</p>
  <h3>Availability</h3>
  <p class="muted">The availability intent is yours to state; the platform's availability facts (when the deployment authority ships) will come from its own projection — never invented here.</p>
  <h3>Version policy</h3>
  <p class="muted">Which version runs and how changes are selected — governed selections with rollback facts, when the authority is public. Today the public API exposes no deployment version facts.</p>
  <h3>Health and channels</h3>
  <p class="muted">Health facts and channel/endpoint bindings are deployment-authority facts; the public API exposes none, so no health metric or endpoint is rendered.</p>
</div>`;
  const content = `${pageHead({
    title: "Build a deployment",
    path: "/build/deployment",
    primaryActionHtml: '<a class="button-link" href="/deployments">View deployments</a>',
  })}
<p>Deployments are persistent availability. ${esc(DEPLOYMENT_EXECUTION_DISTINCTION)}</p>
<form class="flow card" method="get" action="/build/deployment">
  <div class="form-field">
    <label for="deployment-purpose">What should stay available?</label>
    <textarea id="deployment-purpose" name="purpose" placeholder="The support agent, reachable on the ticket channel around the clock.">${esc(
      purpose,
    )}</textarea>
    <p class="form-hint">The availability intent in your words — the design review is honest about what the platform exposes today.</p>
  </div>
  <div class="form-actions"><button type="submit">Review the design</button></div>
</form>
${proposal}
${unavailableState(
  "Deployment creation and commands",
  "No public deployment authority exists — creating a deployment, and the operational controls (pause, rollback, version change), have no governed routes on the public contract. This dashboard renders NO action buttons for them: each control will route through its governed API with a consequence preview before commitment when the authority ships. Meanwhile, availability is never represented as an execution status, and executions remain the live governed work you can follow.",
  "a public deployment authority (create, commands and projections)",
)}
<p><a href="/deployments">View the deployments surface</a> · <a href="/agents">Agent inventory (live, read-only)</a> · <a href="/runs">Executions (live)</a></p>`;
  return page(
    { title: "Zeck — Build a deployment", activePath: "/build/deployment", mainContent: content },
    ctx,
  );
}

async function deploymentsOverviewPage(
  client: ZeckClient,
  ctx: HttpContext,
): Promise<HandlerResult> {
  /**
   * WORK-040 AC3: the live session evidence from this browser's recents
   * scope — for each recent run, the agent-session events (the realtime/
   * messaging/media vocabulary) are read through the governed client and
   * counted; every row links back to the canonical execution context.
   */
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const sessionRuns: {
    readonly executionId: string;
    readonly sessionCount: number;
    readonly lastActivity: string | null;
  }[] = [];
  for (const execution of recents.executions) {
    const sessionFacts = agentSessionFactsOf(
      await client.listEvents(execution.id).catch(() => [] as readonly ExecutionEvent[]),
    );
    if (sessionFacts.present) {
      sessionRuns.push({
        executionId: execution.id,
        sessionCount: sessionFacts.sessionCount,
        lastActivity: sessionFacts.events[sessionFacts.events.length - 1]?.occurredAt ?? null,
      });
    }
  }
  const content = `${pageHead({
    title: "Deployments",
    path: "/deployments",
    primaryActionHtml: '<a class="button-link" href="/build/deployment">Propose a deployment</a>',
  })}
<p>${esc(DEPLOYMENT_EXECUTION_DISTINCTION)}</p>
${unavailableState(
  "Deployment inventory",
  "The public API exposes no deployment authority — no deployment inventory, availability, health, version or channel facts. Nothing is fabricated here: when the deployment authority ships, this page projects its facts live (availability, version, health, channels/endpoints, activity) — never an execution status in their place.",
  "a public deployment authority projection (inventory and detail)",
)}
${deploymentSessionExecutionSection({ sessionRuns })}
<h2>The live governed work today</h2>
<p>Executions are live: <a href="/runs">open the runs surface</a> or look one up by id. Agents are live and read-only: <a href="/agents">open the agent inventory</a>.</p>
${lookupForm()}`;
  return page(
    { title: "Zeck — Deployments", activePath: "/deployments", mainContent: content },
    ctx,
  );
}

async function deploymentDetailPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const deploymentId = ctx.params.deploymentId ?? "";
  const content = `${pageHead({
    title: "Deployment",
    path: "/deployments",
    currentLabel: deploymentId,
  })}
<p class="muted mono">deployment ${esc(deploymentId)}</p>
<p>${esc(DEPLOYMENT_EXECUTION_DISTINCTION)}</p>
<p class="muted">A deployment id and an execution id are different namespaces — this page never renders an execution's status vocabulary, and an execution page never renders a deployment's availability vocabulary.</p>
<h2>At a glance</h2>
${glanceGrid(deploymentGlanceFacts())}
${unavailableState(
  "Deployment detail",
  "The public API exposes no deployment authority, so no deployment record can be read for this id — no availability, version, health, channel or activity facts exist on the public wire, and none are invented.",
  "the deployment authority's own detail projection",
)}
<h2>The governed work behind availability</h2>
<p>When the deployment authority ships, its activity view will link each execution that served this deployment. Today the live record is each execution's own event stream — <a href="/runs">open the runs surface</a> or look one up by id.</p>
${lookupForm()}`;
  return page(
    {
      title: `Zeck — Deployment ${deploymentId}`,
      activePath: `/deployments/${deploymentId}`,
      mainContent: content,
    },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Runs (AC3)
// ---------------------------------------------------------------------------

async function runsOverviewPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const active = recents.executions.filter((execution) => !isTerminal(execution.status));
  const terminal = recents.executions.filter((execution) => isTerminal(execution.status));
  const content = `${pageHead({
    title: "Runs",
    path: "/runs",
    primaryActionHtml: '<a class="button-link primary" href="/build/execution">New work</a>',
  })}
${lookupForm()}
<p class="muted">The public API exposes no execution listing route: runs are discovered by id, or tracked from executions opened in this browser (${esc(
    RECENTS_NOTE,
  )}).</p>
<h2>Active</h2>
${runsList(active, "No active executions opened in this browser yet.")}
<h2>History</h2>
${runsList(terminal, "No finished executions opened in this browser yet.")}
<h2>Scheduled</h2>
<p>No scheduling surface exists in the public API yet. <a href="/runs/scheduled">Scheduled runs</a></p>`;
  return page({ title: "Zeck — Runs", activePath: "/runs", mainContent: content }, ctx);
}

async function runsActivePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const active = recents.executions.filter((execution) => !isTerminal(execution.status));
  const content = `${pageHead({ title: "Active runs", path: "/runs/active" })}
${lookupForm()}
<p class="muted">Executions opened in this browser that are not terminal yet — ${esc(RECENTS_NOTE)}.</p>
${runsList(active, "No active executions opened in this browser yet — start one from Home, or look one up by id.")}
<p><a href="/runs/history">View finished runs</a></p>`;
  return page(
    { title: "Zeck — Active runs", activePath: "/runs/active", mainContent: content },
    ctx,
  );
}

async function runsHistoryPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const terminal = recents.executions.filter((execution) => isTerminal(execution.status));
  const content = `${pageHead({ title: "Run history", path: "/runs/history" })}
${lookupForm()}
<p class="muted">Finished executions opened in this browser — ${esc(RECENTS_NOTE)}.</p>
${runsList(terminal, "No finished executions opened in this browser yet.")}
<p><a href="/runs/active">View active runs</a></p>`;
  return page(
    { title: "Zeck — Run history", activePath: "/runs/history", mainContent: content },
    ctx,
  );
}

async function runsScheduledPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `${pageHead({ title: "Scheduled runs", path: "/runs/scheduled" })}
${lookupForm()}
${unavailableState(
  "Scheduled runs",
  "There is no scheduling surface in the public API yet — executions are created on demand and follow their own lifecycle.",
  "a governed scheduling surface over executions",
)}`;
  return page(
    { title: "Zeck — Scheduled runs", activePath: "/runs/scheduled", mainContent: content },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Execution detail — the canonical work surface (AC2)
// ---------------------------------------------------------------------------

function tabNav(executionId: string, activeTab: string): string {
  const id = encodeURIComponent(executionId);
  const tab = (name: string, label: string): string =>
    `<a href="/runs/${id}?tab=${name}"${
      activeTab === name ? ' aria-current="page"' : ""
    }>${label}</a>`;
  return `<nav class="tabs" aria-label="Execution views">
  ${tab("result", "Result")}
  ${tab("evidence", "Evidence")}
  ${tab("activity", "Activity")}
  ${tab("inspection", "Inspection")}
</nav>`;
}

function notFoundExecutionView(executionId: string, ctx: HttpContext): HandlerResult {
  const content = `${pageHead({ title: "Execution not found", path: "/runs" })}
${errorState(
  "This execution is not visible through the governed API",
  `No execution "${executionId}" was returned — it may belong to another application or not exist. The dashboard can only see executions the API authorizes for this token.`,
  "GET /executions/:id through the Zeck SDK client",
)}
${lookupForm()}`;
  return htmlStatusResult(
    404,
    appShell({
      title: "Zeck — Execution not found",
      activePath: "/runs",
      mainContent: content,
      appearance: appearanceOf(ctx.cookies),
      mode: modeOf(ctx.cookies),
      returnTo: "/runs",
    }),
  );
}

/**
 * WORK-038: the axis labels come from the ONE trust presentation module
 * (trust.ts) — every route uses the same semantic vocabulary.
 */
function activityView(
  execution: Execution,
  events: readonly ExecutionEvent[],
  view: string,
): string {
  const id = encodeURIComponent(execution.id);
  /**
   * WORK-036 AC6: the advanced inspection views (Events, Raw — the Graph is
   * an honest not-exposed expert surface) live INSIDE the advanced
   * disclosure; the chronological timeline is the default presentation.
   */
  const advancedActivity = advancedDisclosure(
    "Advanced views: Graph, Events, Raw",
    `<p class="muted">The chronological timeline above is the default progress presentation. Graph, raw events and raw payloads are advanced inspection views.</p>
${emptyState(
  "Graph view",
  "The execution graph view is an expert surface; the public projection exposes the chronological timeline and raw events.",
)}
<p>Advanced views: <a href="/runs/${id}?tab=activity&amp;view=events">raw events</a> · <a href="/runs/${id}?tab=activity&amp;view=raw">raw payloads</a> · <a href="/runs/${id}?tab=activity">timeline</a></p>`,
  );
  if (view === "events") {
    const rows = [...events]
      .sort((a, b) => a.sequence - b.sequence)
      .map(
        (event) => `<tr>
      <td>${esc(event.sequence)}</td>
      <td class="mono">${esc(event.type)}</td>
      <td class="mono">${esc(event.eventId)}</td>
      <td class="mono">${esc(event.occurredAt)}</td>
    </tr>`,
      )
      .join("");
    return `<h2>Activity</h2>
<p class="muted">Advanced view — raw events. <a href="/runs/${id}?tab=activity">Return to the timeline</a> · <a href="/runs/${id}?tab=activity&amp;view=raw">raw payloads</a></p>
<table class="data">
  <thead><tr><th scope="col">#</th><th scope="col">Type</th><th scope="col">Event id</th><th scope="col">Occurred</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  }
  if (view === "raw") {
    const blocks = [...events]
      .sort((a, b) => a.sequence - b.sequence)
      .map(
        (event) => `<h3 class="mono">${esc(event.type)} <span class="muted">#${esc(
          event.sequence,
        )}</span></h3>
<pre class="raw">${esc(JSON.stringify(redactSecretShaped(event.payload), null, 2) ?? "{}")}</pre>`,
      )
      .join("\n");
    return `<h2>Activity</h2>
<p class="muted">Advanced view — raw payloads. <a href="/runs/${id}?tab=activity">Return to the timeline</a> · <a href="/runs/${id}?tab=activity&amp;view=events">raw events</a></p>
${
  events.length === 0
    ? emptyState("No events", "The public event stream is empty for this execution.")
    : blocks
}`;
  }
  return `<h2>Activity</h2>
${progressTimeline(events)}
${advancedActivity}`;
}

async function executionDetailPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const executionId = ctx.params.executionId ?? "";
  let facts: [Execution, ExecutionResult, readonly ExecutionEvent[]];
  try {
    facts = await Promise.all([
      client.getExecution(executionId),
      client.getResult(executionId),
      client.listEvents(executionId),
    ]);
  } catch (error) {
    if (error instanceof ZeckApiError && error.status === 404) {
      return notFoundExecutionView(executionId, ctx);
    }
    throw error;
  }
  const [execution, result, events] = facts;
  const setCookies = [
    recentsCookieHeader(addRecent(parseRecents(ctx.cookies[RECENTS_COOKIE]), execution.id)),
  ];
  /**
   * WORK-037 AC8: the long-running workload view — rendered ONLY when the
   * run's public event stream carries long-running facts (checkpoints or
   * recovery events). Progress, checkpoint recency, spend, recovery state
   * and the AC7 four-state distinction — never lease/heartbeat mechanics.
   */
  const workload = deriveWorkloadFacts(events);
  const workloadBlock = workload.present
    ? longRunningWorkloadSection({ execution, result, workload })
    : "";
  /**
   * WORK-040: the inspection + modality derivations, computed ONCE —
   * every fact below is this run's own public event stream, read
   * through the pure projection functions only.
   */
  const decision = planningDecisionOf(events);
  const modalities = modalitySections({
    executionId: execution.id,
    status: execution.status,
    environmentId: execution.environmentId,
    computerUse: computerUseFactsOf(events),
    agentSessions: agentSessionFactsOf(events),
    media: mediaFactsOf(events),
    edge: edgeFactsOf(decision),
    training: trainingFactsOf(events),
    economic: economicFactsOf(events),
  });
  const header = executionHeader({
    execution,
    durationMs: durationMs(execution.createdAt, execution.terminalAt, Date.now()),
    costMicroUsd: result.cost === null ? null : result.cost.totalMicroUsd,
    verificationChip: deriveVerificationChip(result.verification),
    trustAxes: deriveTrustAxes(execution, result, events).map((axis) => ({
      kind: trustAxisLabel(axis.kind),
      label: axis.label,
    })),
  });
  const title = executionTitle(execution.task, execution.id);
  const head = pageHead({
    title,
    path: `/runs/${execution.id}`,
    currentLabel: title,
    headingHtml: `${esc(title)}\n    ${statusBadge(execution.status)}`,
  });
  if (ctx.query.get("action") === "cancel" && !isTerminal(execution.status)) {
    const content = `${head}
${header}
${workloadBlock}
${confirmationCard({
  title: "Cancel this execution?",
  consequence:
    "Cancelling stops the execution at its current state. Work already performed is kept and stays inspectable; the execution moves to the terminal state Cancelled and cannot be resumed.",
  affected: `The execution "${title}" (${execution.id}).`,
  cost: "No further spend accrues after cancellation; already-settled cost stays recorded.",
  whyAllowed:
    "The governed cancel command — it goes through the platform's execution lifecycle authority, which validates it.",
  reversible: false,
  approvalNote: "No separate approval is required for cancellation by this token.",
  idempotencyNote:
    "The confirmation carries an idempotency key, so a double submit converges on one cancellation.",
  hiddenFields: [["idempotencyKey", `dash-${crypto.randomUUID()}`]],
  confirmAction: `/runs/${encodeURIComponent(execution.id)}/cancel`,
  confirmLabel: "Cancel execution",
  cancelHref: `/runs/${encodeURIComponent(execution.id)}`,
})}`;
    return page(
      {
        title: `Zeck — Cancel ${execution.id}`,
        activePath: `/runs/${execution.id}`,
        mainContent: content,
      },
      ctx,
      { setCookies },
    );
  }
  const tabParam = ctx.query.get("tab") ?? "result";
  const tab =
    tabParam === "evidence" || tabParam === "activity" || tabParam === "inspection"
      ? tabParam
      : "result";
  const viewParam = ctx.query.get("view") ?? "";
  const view = viewParam === "events" || viewParam === "raw" ? viewParam : "";
  let panel: string;
  if (tab === "evidence") {
    /**
     * WORK-038 AC2/AC3/AC4: the Evidence view — the four axes (each mapped
     * to its evidence location with contextual links), the verification
     * table with LINKED evidence refs (a ref becomes a link only when the
     * platform exposes an artifact with that id on this execution), the
     * provenance disclosure (id'd as the provider axis's anchor), and the
     * contextual traversal strip (result / activity / artifacts — never
     * back through an index).
     */
    const verification = await client.listVerification(executionId);
    const axes = deriveTrustAxes(execution, result, events);
    const renderRef = (reference: string): string =>
      evidenceRefLink(reference, result.outputArtifacts, execution.id);
    const routeSummary =
      result.route === null
        ? '<p class="muted">No route is recorded yet.</p>'
        : keyValueTable([
            ["provider", result.route.provider ?? "(deterministic)"],
            ["model", result.route.model ?? "—"],
            ["strategy class", result.route.strategyClass ?? "—"],
            ["model calls", String(result.route.modelCalls)],
          ]);
    const warnings =
      result.warnings.length === 0
        ? '<p class="muted">No warnings recorded.</p>'
        : `<ul>${result.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>`;
    const artifactsBlock =
      result.outputArtifacts.length === 0
        ? emptyState(
            "No output artifacts",
            "This execution produced no output artifacts (or has not reached that point yet) — the checks' evidence refs link to artifacts when the platform records them.",
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
    panel = `<h2>Evidence</h2>
${trustAxesTable(axes, execution.id)}
<h3 id="verification-results">Verification results</h3>
${verificationSummary(verification, { executionId: execution.id, renderEvidenceRef: renderRef })}
<h3>Artifacts referenced by this run</h3>
${artifactsBlock}
${contextTraversal({ executionId: execution.id, includeArtifact: false })}
${advancedDisclosure(
  "Route, compute and warnings (advanced)",
  `<p class="muted">Route detail is secondary — provider and model are never the primary mental model.</p>
${routeSummary}
${keyValueTable([
  ["compute environment", execution.environmentId === null ? "default" : execution.environmentId],
  [
    "usage",
    result.usage === null
      ? "—"
      : `${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`,
  ],
])}
<h4>Warnings</h4>
${warnings}`,
)}`;
  } else if (tab === "activity") {
    panel = activityView(execution, events, view);
  } else if (tab === "inspection") {
    /**
     * WORK-040 AC1: the expert inspection view — the recorded planning
     * decision (plan, capabilities, effective policy, route, compute
     * substrate), the events/lineage/audit cross-links. Deep internals
     * sit inside collapsed disclosures (progressive disclosure); the
     * default flows are unchanged (the Result view stays primary).
     */
    panel = inspectionPanel({
      executionId: execution.id,
      environmentId: execution.environmentId,
      decision,
    });
  } else {
    panel = `<h2>Result</h2>
${resultSurface({
  execution,
  result,
  events,
  trustSummaryHtml: trustSummarySection({ execution, result, events }),
})}`;
  }
  // WORK-039 AC2: the blocked explanation renders when (and only when) the
  // platform recorded a policy denial on this run's event stream — the
  // controlling rule in the platform's own words, never re-resolved here.
  const denial = policyDenialOf(events);
  const content = `${head}
${header}
${workloadBlock}
${denial === null ? "" : blockedExplanation(denial)}
${modalities}
${whyPanel({ execution, result, events })}
${tabNav(execution.id, tab)}
${panel}`;
  return page(
    {
      title: `Zeck — ${executionTitle(execution.task, execution.id)}`,
      activePath: `/runs/${execution.id}`,
      mainContent: content,
    },
    ctx,
    { setCookies },
  );
}

async function cancelExecutionHandler(
  client: ZeckClient,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const executionId = ctx.params.executionId ?? "";
  const idempotencyKey = (ctx.form.idempotencyKey ?? "").trim();
  try {
    await client.cancelExecution(
      executionId,
      idempotencyKey.length > 0 ? idempotencyKey : undefined,
    );
    return redirectResult(`/runs/${encodeURIComponent(executionId)}`);
  } catch (error) {
    if (error instanceof ZeckApiError && error.status === 409) {
      return redirectResult(`/runs/${encodeURIComponent(executionId)}`);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Agents (live reads)
// ---------------------------------------------------------------------------

function agentStatusBadge(status: string): string {
  const symbol = status === "active" ? "✓" : status === "suspended" ? "⏸" : "⏱";
  return `<span class="badge"><span class="symbol" aria-hidden="true">${esc(
    symbol,
  )}</span>${esc(status)}</span>`;
}

async function agentsPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const agents = await client.listAgents();
  const rows = agents
    .map(
      (agent) => `<tr>
    <td><a href="/agents/${encodeURIComponent(agent.id)}">${esc(agent.name)}</a></td>
    <td class="mono">${esc(agent.slug)}</td>
    <td>${agentStatusBadge(agent.status)}</td>
    <td class="mono">${agent.activeVersion === null ? "—" : esc(agent.activeVersion)}</td>
    <td class="mono">${esc(agent.updatedAt)}</td>
  </tr>`,
    )
    .join("");
  const content = `${pageHead({
    title: "Agents",
    path: "/agents",
    primaryActionHtml: '<a class="button-link" href="/build/agent">Propose an agent</a>',
  })}
<p class="muted">A read-only projection over the governed agents authority.</p>
${
  agents.length === 0
    ? emptyState(
        "No registered agents",
        "The agents authority returned no agents for this application — create agents through your governed application path.",
      )
    : `<table class="data">
  <thead><tr><th scope="col">Name</th><th scope="col">Slug</th><th scope="col">Status</th><th scope="col">Active version</th><th scope="col">Updated</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`
}`;
  return page({ title: "Zeck — Agents", activePath: "/agents", mainContent: content }, ctx);
}

async function agentDetailPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const agentId = ctx.params.agentId ?? "";
  const status = await client.getAgentStatus(agentId);
  const versionsRows = status.availableVersions
    .map(
      (version) => `<tr>
    <td class="mono">${esc(version.version)}</td>
    <td class="mono">${esc(version.definitionDigest)}</td>
    <td>${esc(version.validationState)}</td>
    <td>${version.validationNotes === null ? "—" : esc(version.validationNotes)}</td>
    <td class="mono">${esc(version.createdAt)}</td>
  </tr>`,
    )
    .join("");
  const selection =
    status.latestSelection === null
      ? '<p class="muted">No selection history is recorded yet.</p>'
      : keyValueTable([
          ["kind", status.latestSelection.kind],
          ["selected version", status.latestSelection.selectedVersionId],
          ["rollback of", status.latestSelection.rollbackOf ?? "—"],
          ["selected by", status.latestSelection.selectedBy],
          ["selected at", status.latestSelection.selectedAt],
        ]);
  /**
   * WORK-037 AC3: the at-a-glance grid — purpose, capabilities,
   * tools/integrations, autonomy, approvals, quality, cost, version and
   * current deployment, each a platform fact (from the public agent
   * projection) or the explicit honest absence. AC9: the executions
   * cross-link section right below it.
   */
  const content = `${pageHead({
    title: status.agent.name,
    path: `/agents/${agentId}`,
    currentLabel: status.agent.name,
    primaryActionHtml: `<a class="button-link" href="/build/agent">Propose an agent</a>`,
  })}
<p>${
    status.agent.description === null
      ? '<span class="muted">No description recorded.</span>'
      : esc(status.agent.description)
  }</p>
<p>${agentStatusBadge(status.agent.status)}</p>
<h2>At a glance</h2>
${glanceGrid(agentGlanceFacts(status))}
<h2>Runs and evidence</h2>
<p class="muted">The public execution contract carries no agent attribution — the create contract forbids agent selection (the platform routes work to agents), so no per-agent execution listing can exist on the public wire. Executions are discoverable by id, and each run's Evidence view carries its verification results.</p>
${lookupForm()}
<p><a href="/runs">Open the runs surface</a> · <a href="/assets/artifacts">Artifacts from executions opened in this browser</a></p>
${advancedDisclosure(
  "Versions and selection history (advanced)",
  `<h4>Available versions</h4>
${
  status.availableVersions.length === 0
    ? '<p class="muted">No versions recorded.</p>'
    : `<table class="data">
  <thead><tr><th scope="col">Version</th><th scope="col">Definition digest</th><th scope="col">Validation</th><th scope="col">Notes</th><th scope="col">Created</th></tr></thead>
  <tbody>${versionsRows}</tbody>
</table>`
}
<h4>Latest selection</h4>
${selection}
<p class="muted">Promotion and rollback are governed selections recorded platform-side (the selection kind and who made it are the public facts); no selection command is exposed by the public API — this dashboard renders no version-change action.</p>`,
)}`;
  return page(
    {
      title: `Zeck — ${status.agent.name}`,
      activePath: `/agents/${agentId}`,
      mainContent: content,
    },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Assets (AC5) — honest states + per-execution artifact anchors
// ---------------------------------------------------------------------------

async function artifactsPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const sections: string[] = [];
  for (const execution of recents.executions) {
    const result = await client.getResult(execution.id);
    if (result.outputArtifacts.length === 0) {
      continue;
    }
    const rows = result.outputArtifacts
      .map(
        (artifact) => `<tr>
      <td><a href="/assets/artifacts/${encodeURIComponent(
        artifact.id,
      )}?executionId=${encodeURIComponent(execution.id)}">${esc(artifact.id)}</a></td>
      <td class="mono">${artifact.digest === null ? "—" : esc(artifact.digest)}</td>
      <td class="mono">${esc(artifact.createdAt)}</td>
    </tr>`,
      )
      .join("");
    sections.push(`<h3><a href="/runs/${encodeURIComponent(execution.id)}">${esc(
      executionTitle(execution.task, execution.id),
    )}</a> ${statusBadge(execution.status)}</h3>
<table class="data">
  <thead><tr><th scope="col">Artifact</th><th scope="col">Digest</th><th scope="col">Created</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`);
  }
  const content = `${pageHead({ title: "Artifacts", path: "/assets/artifacts" })}
${unavailableState(
  "Artifact inventory",
  "The public API exposes artifacts only as per-execution output references — there is no artifact listing route.",
  "an artifact inventory projection over executions",
)}
<h2>Artifacts from executions opened in this browser</h2>
${
  sections.length === 0
    ? emptyState(
        "No artifacts yet",
        "No executions opened in this browser produced output artifacts — open an execution to see its output artifacts.",
      )
    : `<p class="muted">${esc(RECENTS_NOTE)}</p>${sections.join("\n")}`
}`;
  return page(
    { title: "Zeck — Artifacts", activePath: "/assets/artifacts", mainContent: content },
    ctx,
  );
}

/**
 * WORK-038 AC5: the artifact view — preview/metadata, provenance, parent
 * lineage, verification references, usage references and contextual
 * traversal, each a public-wire fact or an explicit honest absence.
 *
 * The public API exposes artifacts ONLY as per-execution output
 * references (id/digest/createdAt): the producing-execution context is
 * resolved from the URL (the contextual links carry it), or — when
 * absent — from the executions opened in this browser whose recorded
 * outputs include this artifact (a public-fact resolution, never a
 * fabricated producer). The platform's own records carry the rest: the
 * `execution.created` event's inputArtifactRefs are the parents; the
 * verification results' evidenceRefs are the verification references;
 * other executions' recorded inputs are the usage references.
 */
interface ArtifactUsageRow {
  readonly executionId: string;
  readonly title: string;
}

async function collectArtifactUsages(
  client: ZeckClient,
  ids: readonly string[],
  artifactId: string,
  excludeExecutionId: string | null,
): Promise<readonly ArtifactUsageRow[]> {
  const usages: ArtifactUsageRow[] = [];
  for (const id of ids) {
    if (id === excludeExecutionId) {
      continue;
    }
    try {
      const [execution, events] = await Promise.all([
        client.getExecution(id),
        client.listEvents(id),
      ]);
      if (consumesArtifact(events, artifactId)) {
        usages.push({ executionId: id, title: executionTitle(execution.task, id) });
      }
    } catch (error) {
      if (error instanceof ZeckApiError && error.status === 404) {
        continue;
      }
      throw error;
    }
  }
  return usages;
}

async function resolveProducingExecution(
  client: ZeckClient,
  artifactId: string,
  explicitExecutionId: string | null,
): Promise<
  | {
      readonly source: "url" | "recents";
      readonly execution: Execution;
      readonly result: ExecutionResult;
      readonly events: readonly ExecutionEvent[];
      readonly verification: readonly VerificationResult[];
      readonly artifact: ArtifactReference | undefined;
    }
  | { readonly source: "url-missing" }
  | null
> {
  if (explicitExecutionId !== null && explicitExecutionId.length > 0) {
    try {
      const [execution, result, events, verification] = await Promise.all([
        client.getExecution(explicitExecutionId),
        client.getResult(explicitExecutionId),
        client.listEvents(explicitExecutionId),
        client.listVerification(explicitExecutionId),
      ]);
      return {
        source: "url",
        execution,
        result,
        events,
        verification,
        artifact: result.outputArtifacts.find((candidate) => candidate.id === artifactId),
      };
    } catch (error) {
      if (error instanceof ZeckApiError && error.status === 404) {
        return { source: "url-missing" };
      }
      throw error;
    }
  }
  return null;
}

async function artifactDetailPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const artifactId = ctx.params.artifactId ?? "";
  const executionIdParam = ctx.query.get("executionId");
  const recentsIds = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const resolved = await resolveProducingExecution(client, artifactId, executionIdParam);

  if (resolved === null) {
    // No URL context: resolve the producing execution from the public
    // output references of executions opened in this browser (never a
    // fabricated producer; no artifact-by-id route exists on the wire).
    for (const id of recentsIds) {
      try {
        const result = await client.getResult(id);
        if (result.outputArtifacts.some((candidate) => candidate.id === artifactId)) {
          const [execution, events, verification] = await Promise.all([
            client.getExecution(id),
            client.listEvents(id),
            client.listVerification(id),
          ]);
          const usages = await collectArtifactUsages(client, recentsIds, artifactId, id);
          return artifactDetailRender(
            {
              execution,
              result,
              events,
              verification,
              artifact: result.outputArtifacts.find((candidate) => candidate.id === artifactId),
            },
            artifactId,
            ctx,
            usages,
          );
        }
      } catch (error) {
        if (error instanceof ZeckApiError && error.status === 404) {
          continue;
        }
        throw error;
      }
    }
    const usages = await collectArtifactUsages(client, recentsIds, artifactId, null);
    const content = `${pageHead({
      title: "Artifact",
      path: "/assets/artifacts",
      currentLabel: artifactId,
    })}
<p class="muted mono">${esc(artifactId)}</p>
${unavailableState(
  "Artifact detail",
  "No producing execution for this artifact is visible here: the public API exposes artifacts only as per-execution output references (id, digest, createdAt) — there is no artifact-by-id route, and no execution opened in this browser records this artifact as an output. Metadata, provenance and lineage render when the artifact is opened from the execution that produced it.",
  "an artifact content and lineage projection over executions",
)}
<h2>Usage references</h2>
${artifactUsageReferences(usages)}
${lookupForm()}`;
    return page(
      { title: "Zeck — Artifact", activePath: "/assets/artifacts", mainContent: content },
      ctx,
    );
  }

  if (resolved.source === "url-missing") {
    const content = `${pageHead({ title: "Artifact", path: "/assets/artifacts" })}
${errorState(
  "The producing execution is not visible",
  `No execution "${executionIdParam ?? ""}" was returned — it may belong to another application or not exist. The artifact view reads through the governed API only.`,
  "GET /executions/:id (results, events, verification) through the Zeck SDK client",
)}
${lookupForm()}`;
    return page(
      { title: "Zeck — Artifact", activePath: "/assets/artifacts", mainContent: content },
      ctx,
    );
  }

  const usages = await collectArtifactUsages(client, recentsIds, artifactId, resolved.execution.id);
  return artifactDetailRender(resolved, artifactId, ctx, usages);
}

function artifactDetailRender(
  resolved: {
    readonly execution: Execution;
    readonly result: ExecutionResult;
    readonly events: readonly ExecutionEvent[];
    readonly verification: readonly VerificationResult[];
    readonly artifact: ArtifactReference | undefined;
  },
  artifactId: string,
  ctx: HttpContext,
  usages: readonly ArtifactUsageRow[],
): HandlerResult {
  const { execution, result, events, verification, artifact } = resolved;
  const id = encodeURIComponent(execution.id);
  const title = executionTitle(execution.task, execution.id);
  const taskPairs = safeTaskPairs(execution.task);
  const route =
    result.route === null
      ? '<p class="muted">No route is recorded for the producing execution.</p>'
      : keyValueTable([
          ["strategy class", result.route.strategyClass ?? "—"],
          ["provider", result.route.provider ?? "(deterministic)"],
          ["model", result.route.model ?? "—"],
          ["model calls", String(result.route.modelCalls)],
        ]);
  const artifactFacts =
    artifact === undefined
      ? errorState(
          "This artifact is not among the execution's recorded outputs",
          `The execution "${execution.id}" is visible, but its recorded output artifacts do not include "${artifactId}" — the reference may be an input reference, belong to another execution, or not exist. The dashboard shows only the references the platform records.`,
        )
      : artifactMetadataTable(artifact);
  const content = `${pageHead({
    title: "Artifact",
    path: "/assets/artifacts",
    currentLabel: artifactId,
  })}
<p class="muted mono">${esc(artifactId)}</p>
${contextTraversal({ executionId: execution.id, artifactId, includeArtifact: false })}
<h2>Metadata</h2>
${artifactFacts}
<h2>Preview</h2>
${unavailableState(
  "Artifact content preview",
  "Artifact content is not exposed by the public API — artifacts cross the wire as id/digest/createdAt references only, so no preview can be rendered without inventing content. The recorded digest above is the platform's content identity for this artifact.",
  "an artifact content projection (streaming or bounded preview) over the artifact authority",
)}
<h2>Provenance — the producing execution</h2>
${keyValueTable([
  ["execution", execution.id],
  ["outcome", title],
  ["status", `${currentStageLabel(execution.status)} (${execution.status})`],
  ["produced at", artifact === undefined ? "—" : artifact.createdAt],
  ["application", execution.applicationId],
])}
${advancedDisclosure("Route of the producing execution (advanced)", route)}
<h2>Source — what was asked</h2>
${
  taskPairs.length === 0
    ? '<p class="muted">The public task record carries no fields for the producing execution.</p>'
    : keyValueTable(taskPairs)
}
<h2>Parent lineage</h2>
${artifactParentLineage(inputArtifactRefsOf(events), execution.id)}
<h2>Verification references</h2>
${artifactVerificationReferences(verification, artifactId, execution.id)}
<h2>Usage references</h2>
${artifactUsageReferences(usages)}
<p class="muted">${esc(TRUST_NOTE)}</p>
<div class="actions">
  <a class="button-link" href="/runs/${id}">Open the result</a>
  <a href="/runs/${id}?tab=evidence">Open the evidence</a>
  <a href="/runs/${id}?tab=activity">Open the activity</a>
</div>`;
  return page(
    {
      title: `Zeck — Artifact ${artifactId}`,
      activePath: "/assets/artifacts",
      mainContent: content,
    },
    ctx,
  );
}

/**
 * WORK-038 AC6 + Implementation Requirement 4: competence discovery —
 * the discovery fact families (task outcome, relevance, success rate,
 * typical cost/time, verification status) render as the honest structure
 * they will take when the competence authority ships; every cell states
 * the explicit absence today. Using a competence is a GOVERNED WORK
 * ACTION through the create path — never a local execution shortcut,
 * and the frozen create contract carries no competence-selection field
 * (the platform routes work itself).
 */
async function competencesPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `${pageHead({ title: "Competences", path: "/assets/competences" })}
<p>A competence is a reusable, validated way of accomplishing work — represented by the platform's competence authority, anchored to the evidence of the runs that shaped it. Discovery is organized around what you care about when you reuse work:</p>
${glanceGrid(competenceDiscoveryFacts())}
${unavailableState(
  "Competence discovery",
  "The competence authority is not exposed by the public API — no competence inventory, search or relevance ranking exists on the public wire, so no competence is listed here. When it ships, its facts feed the discovery grid above live — success rates, typical costs and verification statuses will be the authority's own recorded facts, never dashboard estimates.",
  "the competence authority through the public API",
)}
<h2>Using a competence</h2>
<p>Using a competence is a governed work action: you describe the outcome and <a href="/build/execution">start it through the governed create path</a> — the same consequence preview and the same platform policy admission as any work. The public create contract carries no competence-selection field (selection is decided platform-side during planning), so this dashboard never offers a competence picker and never runs anything locally on a competence's behalf.</p>
${lookupForm()}`;
  return page(
    { title: "Zeck — Competences", activePath: "/assets/competences", mainContent: content },
    ctx,
  );
}

/**
 * WORK-038 AC7: competence detail — provenance, procedures, validation
 * population, uncertainty, compatibility and promotion state render ONLY
 * when available from the API. None are public today, so each family
 * states the explicit absence; the promotion cell states the boundary —
 * promotion is decided by the competence authority's own validation and
 * promotion rules, and nothing on this page implies a promotion or a
 * validated state (learning stays advisory until those rules are
 * satisfied).
 */
async function competenceDetailPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const competenceId = ctx.params.competenceId ?? "";
  const content = `${pageHead({
    title: "Competence",
    path: "/assets/competences",
    currentLabel: competenceId,
  })}
<p class="muted mono">${esc(competenceId)}</p>
${unavailableState(
  "Competence detail",
  "The competence authority is not exposed by the public API — no record for this id can be read through the public wire, so no procedures, statistics or states are shown. The fact families below render as the authority exposes them — only then, never before.",
  "the competence authority's own detail projection",
)}
<h2>What a competence's detail carries (when the authority is public)</h2>
${glanceGrid(competenceDetailFacts())}
<h2>Using this competence</h2>
<p>Using a competence is a governed work action: describe the outcome and <a href="/build/execution">start it through the governed create path</a>. The create contract carries no competence-selection field — this page offers no picker, no local run and no shortcut, and it never implies this competence is validated or promoted.</p>
<p><a href="/assets/competences">Back to competences</a> · <a href="/build/execution">Start governed work</a></p>`;
  return page(
    { title: "Zeck — Competence", activePath: "/assets/competences", mainContent: content },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// WORK-038: the Trust surfaces — live per-execution evidence and lineage
// anchors (from the executions opened in this browser), with the honest
// cross-work absence notes (no public evidence/lineage authority exists)
// ---------------------------------------------------------------------------

/**
 * WORK-038: the evidence surface — per-execution evidence anchors from the
 * live recents scope, each carrying the platform's own verification chip
 * and links to the run's Evidence view and artifacts. A cross-work
 * evidence search is NOT public — stated honestly, never fabricated.
 */
async function trustEvidencePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const sections: string[] = [];
  for (const execution of recents.executions) {
    let chip = "No verification results";
    let artifactsCount = 0;
    try {
      const result = await client.getResult(execution.id);
      chip = deriveVerificationChip(result.verification);
      artifactsCount = result.outputArtifacts.length;
    } catch (error) {
      if (!(error instanceof ZeckApiError && error.status === 404)) {
        throw error;
      }
    }
    const id = encodeURIComponent(execution.id);
    sections.push(`<li>
  <a class="run-title" href="/runs/${id}?tab=evidence">${esc(
    executionTitle(execution.task, execution.id),
  )}</a>
  ${statusBadge(execution.status)}
  <span class="axis-fact">${esc(chip)}</span>
  <a href="/runs/${id}">Result</a> · <a href="/runs/${id}?tab=activity">Activity</a> · <a href="/assets/artifacts">Artifacts (${artifactsCount})</a>
</li>`);
  }
  const content = `${pageHead({ title: "Evidence", path: "/trust/evidence" })}
<p>Evidence is why a result can be trusted — the platform's verification checks, their recorded evidence refs, and the provenance of each run. Per-execution evidence is live through the governed API; open a run's Evidence view for the full check table with linked refs.</p>
${
  sections.length === 0
    ? emptyState(
        "No evidence to show yet",
        "No executions opened in this browser — start work, or look an execution up by id; its Evidence view carries the recorded checks.",
      )
    : `<p class="muted">${esc(RECENTS_NOTE)}.</p>
<ul class="runs-list">${sections.join("\n")}</ul>`
}
${unavailableState(
  "Cross-work evidence",
  "A cross-work evidence surface — searching checks and evidence across ALL executions, not just those opened in this browser — is not exposed by the public API (there is no execution listing route). Nothing is fabricated here; when the projection ships, its facts feed this page through the same trust vocabulary.",
  "an evidence projection over executions and verification records",
)}
${lookupForm()}`;
  return page(
    { title: "Zeck — Evidence", activePath: "/trust/evidence", mainContent: content },
    ctx,
    { setCookies },
  );
}

/**
 * WORK-038: the lineage surface (expert) — the per-execution lineage chain
 * that IS public: the recorded inputs (parent artifacts) → the execution
 * → its recorded outputs, every link contextual. The cross-work lineage
 * graph (dags, downstream usage beyond this browser) is NOT public —
 * stated honestly.
 */
async function trustLineagePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const sections: string[] = [];
  for (const execution of recents.executions) {
    let inputRefs: readonly string[] = [];
    let outputs: readonly { id: string; digest: string | null }[] = [];
    try {
      const [events, result] = await Promise.all([
        client.listEvents(execution.id),
        client.getResult(execution.id),
      ]);
      inputRefs = inputArtifactRefsOf(events);
      outputs = result.outputArtifacts;
    } catch (error) {
      if (!(error instanceof ZeckApiError && error.status === 404)) {
        throw error;
      }
    }
    const id = encodeURIComponent(execution.id);
    const inputsHtml =
      inputRefs.length === 0
        ? '<span class="muted">no recorded input references</span>'
        : inputRefs
            .map(
              (ref) =>
                `<a class="evidence-ref" href="/assets/artifacts/${encodeURIComponent(
                  ref,
                )}?executionId=${id}">${esc(ref)}</a>`,
            )
            .join("\n    ");
    const outputsHtml =
      outputs.length === 0
        ? '<span class="muted">no recorded output artifacts</span>'
        : outputs
            .map(
              (artifact) =>
                `<a class="evidence-ref" href="/assets/artifacts/${encodeURIComponent(
                  artifact.id,
                )}?executionId=${id}">${esc(artifact.id)}</a>`,
            )
            .join("\n    ");
    sections.push(`<li class="lineage-chain">
  <div class="lineage-step"><span class="glance-kind">Inputs (parents)</span>\n    ${inputsHtml}</div>
  <div class="lineage-step"><span class="glance-kind">Execution</span>\n    <a href="/runs/${id}">${esc(
    executionTitle(execution.task, execution.id),
  )}</a> ${statusBadge(execution.status)}</div>
  <div class="lineage-step"><span class="glance-kind">Outputs</span>\n    ${outputsHtml}</div>
</li>`);
  }
  const content = `${pageHead({ title: "Lineage", path: "/trust/lineage" })}
<p>Lineage connects artifacts to their producing executions, parent artifacts and downstream usage. The per-run chain — the platform's own recorded inputs and outputs — is live below; open any artifact for its full provenance, parent lineage, verification and usage references.</p>
${
  sections.length === 0
    ? emptyState(
        "No lineage to show yet",
        "No executions opened in this browser — lineage renders from each run's own recorded input and output references.",
      )
    : `<p class="muted">${esc(RECENTS_NOTE)}.</p>
<ul class="lineage-chains">${sections.join("\n")}</ul>`
}
${unavailableState(
  "Cross-work lineage graph",
  "A cross-work lineage graph — every consumer of an artifact across ALL executions, not just those opened in this browser — is not exposed by the public API. The public wire carries per-execution input/output references only; this page renders exactly those and invents no graph.",
  "a lineage projection over execution artifacts",
)}
${lookupForm()}`;
  return page(
    { title: "Zeck — Lineage", activePath: "/trust/lineage", mainContent: content },
    ctx,
    { setCookies },
  );
}

/**
 * WORK-038 AC8: the evaluations surface — observation, recommendation,
 * validation and authoritative production stay four DISTINCT statuses;
 * learning is advisory until the existing validation and promotion rules
 * are satisfied. No public evaluation authority exists — the distinction
 * renders ahead of the facts, with the live per-execution evidence as the
 * closest public record.
 */
async function evaluationsPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `${pageHead({ title: "Evaluations", path: "/improve/evaluations" })}
<p>Evaluations are the records behind quality claims — scored runs over defined datasets, and the improvement pipeline they feed. The four statuses below are the pipeline's distinct stages; no stage is ever implied by another:</p>
${distinctionList(evaluationStatusRows())}
${unavailableState(
  "Evaluation records",
  "The public API does not expose an evaluation authority — no scored runs, datasets or evaluation records cross the public wire, so none are listed here. When the authority ships, its records render through the same four-status vocabulary (an observation will never display as a validated or production fact).",
  "the evaluation authority through the public API",
)}
<h2>The live evaluation facts today</h2>
<p>Per-execution verification results are the live public checks — the runs' recorded PASS/FAIL evidence. <a href="/trust/evidence">Open the evidence surface</a> to see them per execution.</p>`;
  return page(
    { title: "Zeck — Evaluations", activePath: "/improve/evaluations", mainContent: content },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// WORK-039: the Control and Improve surfaces — live presentations over the
// public control-plane facts (the runs opened in this browser + the agent
// inventory), each honest absence anchored to its authority. Policy stays
// the authorization boundary; accounting stays canonical; credentials stay
// secret-mediated; learning stays advisory (never authorization).
// ---------------------------------------------------------------------------

/**
 * WORK-039 AC1/AC2: the Rules surface — user-level controls FIRST (the
 * seven families: quality/spend/latency/approvals live, data/tools/
 * autonomy the honest absences), the live blocked-runs list (each
 * denial's recorded controlling rule + link to the run), and the
 * effective-policy composition as ADVANCED detail (never resolved here).
 */
async function policiesPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const blocked: { id: string; title: string; status: string; denial: PolicyDenialFact }[] = [];
  for (const execution of recents.executions) {
    let events: readonly ExecutionEvent[] = [];
    try {
      events = await client.listEvents(execution.id);
    } catch (error) {
      if (!(error instanceof ZeckApiError && error.status === 404)) {
        throw error;
      }
    }
    const denial = policyDenialOf(events);
    if (denial !== null) {
      blocked.push({
        id: execution.id,
        title: executionTitle(execution.task, execution.id),
        status: execution.status,
        denial,
      });
    }
  }
  const blockedList =
    blocked.length === 0
      ? '<p class="muted">No run opened in this browser carries a recorded policy denial — when the platform refuses admission, the controlling rule is recorded on the run and listed here.</p>'
      : `<ul class="runs-list">${blocked
          .map(
            (item) => `<li>
  <a class="run-title" href="/runs/${encodeURIComponent(item.id)}">${esc(item.title)}</a>
  ${statusBadge(item.status)}
  <span class="axis-fact">Blocked: ${esc(item.denial.reason)}</span>
</li>`,
          )
          .join("\n")}</ul>`;
  const content = `${pageHead({ title: "Rules and controls", path: "/admin/policies" })}
<p>Controls in your language. Each control is a rule the platform enforces at admission — declared per run on the create request, or set by your workspace's effective policy. This surface explains them; it never resolves them.</p>
<h2>The controls</h2>
${controlFamiliesTable()}
<h2>Why work gets blocked</h2>
<p>When the effective policy refuses a run, the platform records the controlling rule on that run's event stream — the reason in the platform's own words, linked from here. No policy-engine internals, and no re-resolution by this dashboard.</p>
${blockedList}
${policyCompositionDisclosure()}
<p class="muted">${esc(RECENTS_NOTE)}.</p>
${lookupForm()}`;
  return page(
    { title: "Zeck — Rules and controls", activePath: "/admin/policies", mainContent: content },
    ctx,
    { setCookies },
  );
}

/**
 * WORK-039 AC3: the Spend surface — the simple view (current usage, the
 * declared limits, the major categories — every figure a platform
 * recording, the sum BigInt-only), the per-run table with links, and the
 * accounting detail (reservations/settlement/ledger) as ADVANCED detail
 * with its honest public absence. No second accounting truth.
 */
async function spendPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const facts: RunSpendFact[] = [];
  for (const execution of recents.executions) {
    let result: ExecutionResult;
    try {
      result = await client.getResult(execution.id);
    } catch (error) {
      if (error instanceof ZeckApiError && error.status === 404) {
        // No result package yet (the run has not settled): the run still
        // renders — its declared limit from the execution record, the
        // honest "not settled yet" for cost, no invented route.
        result = {
          executionId: execution.id,
          status: execution.status,
          route: null,
          cost: null,
          usage: null,
          outputArtifacts: [],
          verification: [],
          warnings: [],
          terminalAt: null,
        };
      } else {
        throw error;
      }
    }
    facts.push(runSpendFacts(execution, result));
  }
  const total = sumMicroUsd(
    facts.map((fact) => fact.costMicroUsd).filter((value): value is string => value !== null),
  );
  const categories = providerCategoryFacts(facts);
  const content = `${pageHead({ title: "Spend", path: "/admin/budgets" })}
<p>Spend in plain language: what work cost, what limits were declared, and where the money went — every figure a platform recording, never a dashboard estimate.</p>
${spendSummarySection({ facts, totalMicroUsd: total, categories })}
<h2>Per-run spend</h2>
${spendRunsTable(facts)}
${accountingDetailDisclosure()}
${unavailableState(
  "Workspace budgets",
  "Workspace-level budgets — the spending ceiling, the remaining budget and the breakdown across ALL work (not just this browser's runs) — are the budgets authority's own records and are not exposed by the public API. The per-run figures above are the live public facts; nothing on this surface competes with the authority's accounting.",
  "the budgets authority through the public API",
)}
<p class="muted">${esc(RECENTS_NOTE)}.</p>
${lookupForm()}`;
  return page({ title: "Zeck — Spend", activePath: "/admin/budgets", mainContent: content }, ctx, {
    setCookies,
  });
}

/**
 * WORK-039 AC4: the Connections surface — the live routing facts (the
 * platform's own opaque provider strings, per run, browser-scoped), the
 * BYOK/secret-mediated setup story, and the honest absence of a
 * connections inventory/health API. No credential-shaped value renders
 * anywhere; no public wire shape even carries a field where a secret
 * could appear.
 */
async function connectionsPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const facts: RunSpendFact[] = [];
  for (const execution of recents.executions) {
    let result: ExecutionResult;
    try {
      result = await client.getResult(execution.id);
    } catch (error) {
      if (error instanceof ZeckApiError && error.status === 404) {
        result = {
          executionId: execution.id,
          status: execution.status,
          route: null,
          cost: null,
          usage: null,
          outputArtifacts: [],
          verification: [],
          warnings: [],
          terminalAt: null,
        };
      } else {
        throw error;
      }
    }
    facts.push(runSpendFacts(execution, result));
  }
  const categories = providerCategoryFacts(facts);
  const content = `${pageHead({ title: "Connections", path: "/assets/connections" })}
<p>Connections are governed server-side — you bring your own keys, and the platform mediates every credential. What is live here is the routing the platform recorded for the runs opened in this browser.</p>
${connectionsSection(categories)}
${unavailableState(
  "Connection inventory",
  "An inventory of configured connections — each connection's setup state, health and configuration — is governed by the integrations authority and is not exposed by the public API. No credential, key or token is ever rendered anywhere in this dashboard: no public wire shape carries a field where a secret could appear, and the create contract rejects connection selection fail-closed.",
  "a connections projection over the integrations authority",
)}
<p class="muted">${esc(RECENTS_NOTE)}.</p>
${lookupForm()}`;
  return page(
    { title: "Zeck — Connections", activePath: "/assets/connections", mainContent: content },
    ctx,
    { setCookies },
  );
}

/**
 * WORK-039 AC5: the Environments surface — the environments RECORDED on
 * the runs opened in this browser, each an isolation boundary for
 * governed work (safe operational intent, not backend topology); the
 * environments authority's own inventory/configuration is honestly absent.
 */
async function environmentsPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const facts = environmentFacts(recents.executions);
  const content = `${pageHead({ title: "Environments", path: "/admin/environments" })}
<p>Environments are the isolation boundaries governed work runs in — organized by what they mean for the safety of the work, not by backend topology. Each environment below is recorded on real runs opened in this browser.</p>
${environmentsSection(facts)}
${unavailableState(
  "Environment inventory and configuration",
  "The environments authority's own records — the full inventory, each environment's configuration, capacity and admission rules — are not exposed by the public API. Executions carry their environment id; that recorded fact is exactly what renders here (never a guessed configuration).",
  "the compute environment authority through the public API",
)}
<p class="muted">${esc(RECENTS_NOTE)}.</p>
${lookupForm()}`;
  return page(
    { title: "Zeck — Environments", activePath: "/admin/environments", mainContent: content },
    ctx,
    { setCookies },
  );
}

/**
 * WORK-039 AC5: the Team surface — organized around safe operational
 * intent (who decides what, when governed work waits for a human), with
 * the LIVE approval queue and the honest membership absence.
 */
async function teamPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const approvals = approvalQueueFacts(recents.executions);
  const content = `${pageHead({ title: "Team", path: "/admin/team" })}
<p>Team controls organized around safe operation: who decides what, and when governed work must wait for a human decision before it proceeds.</p>
${teamSection(approvals)}
${unavailableState(
  "Members and roles",
  "Workspace membership — who the members are, their roles and their approval responsibilities — is governed by the membership authority and is not exposed by the public API. The live approval queue above is the platform's own waiting-state record; it never names an approver the API does not expose.",
  "the membership authority through the public API",
)}
<p class="muted">${esc(RECENTS_NOTE)}.</p>
${lookupForm()}`;
  return page({ title: "Zeck — Team", activePath: "/admin/team", mainContent: content }, ctx, {
    setCookies,
  });
}

/**
 * WORK-039: the Audit surface — the per-run governed-action ledgers of
 * the runs opened in this browser (the public event streams ARE the
 * closest live audit record; every command on a run is recorded
 * platform-side, append-only). The cross-work audit surface is honestly
 * absent.
 */
async function auditPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const rows: AuditLedgerRow[] = [];
  for (const execution of recents.executions) {
    let events: readonly ExecutionEvent[] = [];
    try {
      events = await client.listEvents(execution.id);
    } catch (error) {
      if (!(error instanceof ZeckApiError && error.status === 404)) {
        throw error;
      }
    }
    if (events.length === 0) {
      continue;
    }
    const ordered = chronologicalEvents(events);
    const last = ordered[ordered.length - 1];
    rows.push({
      executionId: execution.id,
      eventCount: events.length,
      lastEventAt: last?.occurredAt ?? null,
      lastEventLabel: last === undefined ? null : eventStageLabel(last.type),
    });
  }
  const content = `${pageHead({ title: "Audit", path: "/admin/audit" })}
<p>The governed-action record: every command on a run — create, authorize, dispatch, verification, terminal transitions and denials — is recorded platform-side, append-only. The per-run event ledgers of the runs opened in this browser are the closest live audit record.</p>
${auditLedgerSection(rows)}
${unavailableState(
  "Cross-work audit",
  "The audit authority's own surface — searching governed actions across ALL work, with its retention and export rules — is not exposed by the public API. Each run's event stream (linked above) is the live public record.",
  "the audit authority through the public API",
)}
<p class="muted">${esc(RECENTS_NOTE)}.</p>
${lookupForm()}`;
  return page({ title: "Zeck — Audit", activePath: "/admin/audit", mainContent: content }, ctx, {
    setCookies,
  });
}

/**
 * WORK-039 AC6: the Insights surface — the five recommendation families
 * (observed evidence, expected impact, confidence, affected work,
 * disposition) as the honest structure ahead of the facts, the three
 * dispositions as distinct rows, and the live evidence pointers (each
 * linked to the executions that produced it — IR4).
 */
async function insightsPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `${pageHead({ title: "Insights", path: "/improve/insights" })}
<p>Insights are recommendations to improve your workflows — each presented with its observed evidence, expected impact, confidence, affected work and disposition. The structure below is the honest presentation ahead of the facts: no public recommendation surface exists yet, so every family states exactly where its facts will come from, and nothing here invents a recommendation.</p>
<h2>The recommendation families</h2>
${recommendationFamiliesSection()}
<h2>Dispositions</h2>
${recommendationDispositionList()}
${unavailableState(
  "Recommendations",
  "The learning authority's recommendation records — derived from observed evidence, with their measured impact and confidence — are not exposed by the public API. Nothing here invents a recommendation, an impact figure or a confidence level; the live public evidence is each run's verification results and events.",
  "the learning authority through the public API",
)}
<p>Live today: <a href="/trust/evidence">the evidence surface</a> carries each run's recorded checks; <a href="/improve/evaluations">the evaluations surface</a> carries the observation/recommendation/validation/production distinction; <a href="/improve/learning">the learning surface</a> carries the evidence/recommendation/production distinction with the live selection record.</p>`;
  return page(
    { title: "Zeck — Insights", activePath: "/improve/insights", mainContent: content },
    ctx,
  );
}

/**
 * WORK-039 AC7: the Learning surface — the evidence/recommendation/
 * authoritative-production distinction (three stages, never conflated;
 * the recommendation row carries the never-authorizes boundary), with
 * the LIVE production record beneath (the agent inventory's own
 * promotion/rollback selections, read through the governed API).
 */
async function learningPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const agents = await client.listAgents();
  const selections: AgentSelectionFact[] = [];
  for (const agent of agents) {
    try {
      const status = await client.getAgentStatus(agent.id);
      const fact = agentSelectionFacts(status);
      if (fact !== null) {
        selections.push(fact);
      }
    } catch (error) {
      if (!(error instanceof ZeckApiError && error.status === 404)) {
        throw error;
      }
    }
  }
  const content = `${pageHead({ title: "Learning", path: "/improve/learning" })}
<p>Learning is how Zeck improves over time — observations become recommendations, recommendations become validated improvements, and only the platform's own rules put an improvement into production. The three stages are distinct, and nothing here is ever authorization.</p>
${learningDistinctionSection(selections)}
${unavailableState(
  "Learning telemetry",
  "The learning authority's own records — the telemetry, the recommendation pipeline and the validation populations — are not exposed by the public API. The live public records are the per-run evidence and the agent inventory's selection facts; no recommendation, telemetry or validation state is ever implied from them, and no recommendation can be applied from this surface.",
  "the learning authority through the public API",
)}`;
  return page(
    { title: "Zeck — Learning", activePath: "/improve/learning", mainContent: content },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// The command/search surface (AC6)
// ---------------------------------------------------------------------------

interface CommandMatch {
  readonly kind: string;
  readonly label: string;
  readonly href: string;
}

const COMMAND_EXAMPLES: readonly string[] = [
  "open an execution by its id",
  "cancel an execution (proposed as a confirmation flow)",
  "create a new execution",
  "failed runs",
  "agents",
  "policies",
];

function navigationMatches(query: string): CommandMatch[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2);
  const matches: { match: CommandMatch; score: number; order: number }[] = [];
  navIndex().forEach((item, order) => {
    const haystack = `${item.label} ${item.keywords.join(" ")} ${item.description}`.toLowerCase();
    const score = tokens.filter((token) => haystack.includes(token)).length;
    if (score > 0) {
      matches.push({
        match: { kind: "Navigation", label: item.label, href: item.path },
        score,
        order,
      });
    }
  });
  return matches.sort((a, b) => b.score - a.score || a.order - b.order).map((entry) => entry.match);
}

function proposedActionMatches(query: string, agents: readonly AgentSummary[]): CommandMatch[] {
  const lower = query.toLowerCase();
  const matches: CommandMatch[] = [];
  const cancelMatch = /^cancel\s+(\S+)$/i.exec(query.trim());
  if (cancelMatch !== null) {
    const target = cancelMatch[1] ?? "";
    matches.push({
      kind: "Proposed action",
      label: `Cancel execution ${target} (opens a confirmation flow — nothing is cancelled from here)`,
      href: `/runs/${encodeURIComponent(target)}?action=cancel`,
    });
  }
  if (lower.includes("create") || lower.includes("new execution") || lower.includes("run")) {
    matches.push({
      kind: "Proposed action",
      label: "Create a new execution",
      href: "/build/execution",
    });
  }
  if (lower.includes("agent") || lower.includes("new agent")) {
    matches.push({ kind: "Proposed action", label: "Build an agent", href: "/build/agent" });
  }
  if (lower.includes("training") || lower.includes("workload") || lower.includes("batch")) {
    matches.push({ kind: "Proposed action", label: "Run a workload", href: "/build/workload" });
  }
  if (lower.includes("deploy")) {
    matches.push({
      kind: "Proposed action",
      label: "Open deployments (persistent availability — not exposed by the public API yet)",
      href: "/deployments",
    });
  }
  if (lower.includes("failed") || lower.includes("failure")) {
    matches.push({
      kind: "Proposed action",
      label: "View finished runs (failed runs appear in history)",
      href: "/runs/history",
    });
  }
  if (lower.length >= 2) {
    for (const agent of agents) {
      if (agent.slug.toLowerCase().includes(lower) || agent.name.toLowerCase().includes(lower)) {
        matches.push({
          kind: "Agent",
          label: `Agent: ${agent.name}`,
          href: `/agents/${encodeURIComponent(agent.id)}`,
        });
      }
    }
  }
  return matches;
}

async function commandPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const query = (ctx.query.get("q") ?? "").trim();
  const searchEcho = ctx.query.get("q") ?? "";
  if (query.length === 0) {
    const examples = COMMAND_EXAMPLES.map(
      (example) => `<li><span class="command-example">${esc(example)}</span></li>`,
    ).join("\n  ");
    const content = `${pageHead({ title: "Command", path: "/command" })}
<p>Search and command Zeck from anywhere: navigation, executions, agents and proposed actions.</p>
<h2>How it works</h2>
<ul>
  <li>Press <kbd>Ctrl</kbd>+<kbd>K</kbd> (or <kbd>⌘</kbd>+<kbd>K</kbd>) to open the command surface.</li>
  <li>Type an execution id to open it directly.</li>
  <li>Mutations are never performed from here — they are proposed as links into their confirmation flows (the governed POST path with its own consequence preview).</li>
</ul>
<h2>Examples</h2>
<ul>
  ${examples}
</ul>`;
    return page(
      { title: "Zeck — Command", activePath: "/command", mainContent: content, searchEcho },
      ctx,
    );
  }
  const matches: CommandMatch[] = [];
  if (looksLikeExecutionId(query)) {
    matches.push({
      kind: "Execution",
      label: `Open execution ${query}`,
      href: `/runs/${encodeURIComponent(query)}`,
    });
  }
  let agents: AgentSummary[] = [];
  try {
    agents = [...(await client.listAgents())];
  } catch (error) {
    if (!(error instanceof ZeckApiError && error.status === 404)) {
      throw error;
    }
  }
  matches.push(...navigationMatches(query));
  matches.push(...proposedActionMatches(query, agents));
  const seen = new Set<string>();
  const unique = matches.filter((match) => {
    if (seen.has(match.href)) {
      return false;
    }
    seen.add(match.href);
    return true;
  });
  const listItems = unique
    .map((match) => {
      const isProposal = match.kind === "Proposed action";
      return `<li><a href="${esc(match.href)}">${esc(match.label)}</a><span class="result-kind">${esc(
        match.kind,
      )}${isProposal ? " — opens a confirmation flow" : ""}</span></li>`;
    })
    .join("\n  ");
  const content = `${pageHead({ title: "Command", path: "/command" })}
${
  unique.length === 0
    ? `<div class="state state-empty">
  <p class="state-title">No matches for "${esc(query)}"</p>
  <p class="state-body">Try a navigation word (agents, runs, policies), an execution id, or a phrase like "cancel &lt;execution id&gt;".</p>
</div>`
    : `<p class="muted">Results for "${esc(query)}" — every result is a link; mutations open their confirmation flows.</p>
<ul class="command-results">
  ${listItems}
</ul>`
}`;
  return page(
    { title: `Zeck — Command: ${query}`, activePath: "/command", mainContent: content, searchEcho },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// The attention surface (WORK-035 — the Attention primitive's page)
// ---------------------------------------------------------------------------

async function attentionPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const attention = deriveAttention(recents.executions);
  const content = `${pageHead({ title: "Attention", path: "/attention" })}
<p>Attention aggregates only consequential items — decisions, failed work, and (when the public API exposes them) approvals and improvement recommendations. Routine lifecycle events belong to each execution's Activity.</p>
${attentionSummary(attention)}
<h2>Items that need you</h2>
${
  attention.length === 0
    ? emptyState(
        "Nothing needs your attention",
        "No executions opened in this browser are waiting on a decision or failed. Attention is not a notification feed — routine progress never appears here.",
      )
    : `${attentionArea(attention)}
<p class="muted">${esc(RECENTS_NOTE)}.</p>`
}
${unavailableState(
  "Approvals and improvement recommendations",
  "The public API does not yet expose approval requests or improvement recommendations, so no such items can appear here. When those surfaces ship, their facts will feed this page through the same attention vocabulary — never fabricated in the dashboard.",
  "the approval and learning authorities through the public API",
)}`;
  return page(
    { title: "Zeck — Attention", activePath: "/attention", mainContent: content, attention },
    ctx,
    { setCookies },
  );
}

// ---------------------------------------------------------------------------
// Appearance and experience mode (no-script fallbacks) and static assets
// ---------------------------------------------------------------------------

async function appearancePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const mode = ctx.query.get("mode") ?? "system";
  const returnTo = ctx.query.get("returnTo") ?? "/";
  const safeMode: Appearance = mode === "light" || mode === "dark" ? mode : "system";
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return redirectResult(safeReturnTo, { setCookies: [appearanceCookieHeader(safeMode)] });
}

async function modePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const level = ctx.query.get("level") ?? "professional";
  const returnTo = ctx.query.get("returnTo") ?? "/";
  const safeMode: ExperienceMode =
    level === "simple" || level === "expert" ? level : "professional";
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return redirectResult(safeReturnTo, { setCookies: [modeCookieHeader(safeMode)] });
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

/** Create the dashboard route table bound to one SDK client. */
export function createDashboardRoutes(client: ZeckClient): readonly RouteDefinition[] {
  const wrap = (
    method: "GET" | "POST",
    pattern: string,
    handler: (ctx: HttpContext) => Promise<HandlerResult> | HandlerResult,
  ): RouteDefinition => ({ method, pattern, handler });
  return [
    wrap("GET", "/", (ctx) => homePage(client, ctx)),
    wrap("GET", "/home", () => Promise.resolve(redirectResult("/"))),
    wrap("GET", "/build", (ctx) => buildOverviewPage(client, ctx)),
    wrap("GET", "/build/execution", (ctx) => buildExecutionPage(client, ctx)),
    wrap("POST", "/build/execution", (ctx) => createExecutionHandler(client, ctx)),
    wrap("GET", "/build/agent", (ctx) => buildAgentPage(client, ctx)),
    wrap("GET", "/build/workload", (ctx) => buildWorkloadPage(client, ctx)),
    wrap("POST", "/build/workload", (ctx) => createWorkloadHandler(client, ctx)),
    wrap("GET", "/build/deployment", (ctx) => buildDeploymentPage(client, ctx)),
    wrap("GET", "/deployments", (ctx) => deploymentsOverviewPage(client, ctx)),
    wrap("GET", "/deployments/:deploymentId", (ctx) => deploymentDetailPage(client, ctx)),
    wrap("GET", "/runs", (ctx) => runsOverviewPage(client, ctx)),
    wrap("GET", "/runs/active", (ctx) => runsActivePage(client, ctx)),
    wrap("GET", "/runs/history", (ctx) => runsHistoryPage(client, ctx)),
    wrap("GET", "/runs/scheduled", (ctx) => runsScheduledPage(client, ctx)),
    wrap("GET", "/runs/:executionId", (ctx) => executionDetailPage(client, ctx)),
    wrap("POST", "/runs/:executionId/cancel", (ctx) => cancelExecutionHandler(client, ctx)),
    wrap("GET", "/agents", (ctx) => agentsPage(client, ctx)),
    wrap("GET", "/agents/:agentId", (ctx) => agentDetailPage(client, ctx)),
    wrap("GET", "/assets/artifacts", (ctx) => artifactsPage(client, ctx)),
    wrap("GET", "/assets/artifacts/:artifactId", (ctx) => artifactDetailPage(client, ctx)),
    wrap("GET", "/assets/competences", (ctx) => competencesPage(client, ctx)),
    wrap("GET", "/assets/competences/:competenceId", (ctx) => competenceDetailPage(client, ctx)),
    wrap("GET", "/assets/connections", (ctx) => connectionsPage(client, ctx)),
    wrap("GET", "/improve/evaluations", (ctx) => evaluationsPage(client, ctx)),
    wrap("GET", "/improve/insights", (ctx) => insightsPage(client, ctx)),
    wrap("GET", "/improve/learning", (ctx) => learningPage(client, ctx)),
    wrap("GET", "/admin/policies", (ctx) => policiesPage(client, ctx)),
    wrap("GET", "/admin/budgets", (ctx) => spendPage(client, ctx)),
    wrap("GET", "/admin/team", (ctx) => teamPage(client, ctx)),
    wrap("GET", "/admin/environments", (ctx) => environmentsPage(client, ctx)),
    wrap("GET", "/admin/audit", (ctx) => auditPage(client, ctx)),
    wrap("GET", "/trust/evidence", (ctx) => trustEvidencePage(client, ctx)),
    wrap("GET", "/trust/lineage", (ctx) => trustLineagePage(client, ctx)),
    wrap("GET", "/command", (ctx) => commandPage(client, ctx)),
    wrap("GET", "/attention", (ctx) => attentionPage(client, ctx)),
    wrap("GET", "/mode", (ctx) => modePage(client, ctx)),
    wrap("GET", "/appearance", (ctx) => appearancePage(client, ctx)),
    wrap("GET", "/assets/client.js", (ctx) => {
      void ctx;
      return Promise.resolve(assetResult(CLIENT_SCRIPT, "application/javascript"));
    }),
    // Legacy routes (AC10): every existing dashboard path keeps working.
    wrap("POST", "/executions/:executionId/cancel", (ctx) => cancelExecutionHandler(client, ctx)),
    wrap("GET", "/executions/:executionId", (ctx) =>
      Promise.resolve(redirectResult(`/runs/${encodeURIComponent(ctx.params.executionId ?? "")}`)),
    ),
    wrap("GET", "/executions", (ctx) => {
      const id = ctx.query.get("id");
      if (id !== null && id.length > 0) {
        return Promise.resolve(redirectResult(`/runs/${encodeURIComponent(id)}`));
      }
      return Promise.resolve(redirectResult("/runs"));
    }),
  ];
}
