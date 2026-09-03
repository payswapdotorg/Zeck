/**
 * Zeck dashboard pages (WORK-033) — page composition per route.
 *
 * The route map of the accepted UX implementation plan, preserving every
 * legacy dashboard route (AC10). Every page is a live projection through
 * the SDK client; the ONLY mutations are `createExecution` and
 * `cancelExecution`, both through that client. Surfaces the public API
 * does not expose render honest unavailable states (never fabricated
 * data). Form state flows through hidden fields and query params — there
 * is no server-side session state (M24).
 */

import {
  type AgentSummary,
  type Execution,
  type ExecutionEvent,
  type ExecutionResult,
  ZeckApiError,
  type ZeckClient,
} from "../../sdk";
import { CLIENT_SCRIPT } from "./client";
import {
  advancedDisclosure,
  attentionCard,
  emptyState,
  errorState,
  esc,
  executionHeader,
  keyValueTable,
  progressTimeline,
  resultSurface,
  statusBadge,
  unavailableState,
  verificationSummary,
  whyPanel,
} from "./components";
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
import {
  APPEARANCE_COOKIE,
  addRecent,
  buildExecutionRequest,
  currentStageLabel,
  deriveAttention,
  deriveTrustAxes,
  deriveVerificationChip,
  durationMs,
  executionTitle,
  isTerminal,
  looksLikeExecutionId,
  parseRecents,
  QUALITY_OPTIONS,
  RECENTS_COOKIE,
  redactSecretShaped,
  serializeRecents,
  validateExecutionForm,
} from "./projection";
import { type Appearance, type AppShellInput, appShell, navIndex } from "./shell";

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
  input: Omit<AppShellInput, "appearance">,
  ctx: HttpContext,
  options: { setCookies?: readonly string[] } = {},
): HandlerResult {
  return htmlResult(
    appShell({ ...input, appearance: appearanceOf(ctx.cookies), returnTo: ctx.path }),
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

function attentionCards(items: ReturnType<typeof deriveAttention>): string {
  return items.map((item) => attentionCard(item)).join("\n");
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

function homeOutcomeForm(idempotencyKey: string): string {
  return `<form class="flow card" method="get" action="/build/execution">
  <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
  <div class="form-field">
    <label for="home-outcome">What would you like Zeck to accomplish?</label>
    <textarea id="home-outcome" name="outcome" placeholder="Describe the outcome — Zeck plans, executes and verifies it under policy"></textarea>
  </div>
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
  const content = `<h1>Home</h1>
${homeOutcomeForm(`dash-${crypto.randomUUID()}`)}
<h2>Needs your attention</h2>
${
  attention.length === 0
    ? emptyState(
        "No attention items",
        "No executions opened in this browser need a decision or failed — start one above, or look one up by id.",
      )
    : `<p class="muted">${esc(RECENTS_NOTE)}</p>
${attentionCards(attention)}`
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
<h2>Recent</h2>
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
  return page({ title: "Zeck — Home", activePath: "/", mainContent: content }, ctx, { setCookies });
}

// ---------------------------------------------------------------------------
// Build surfaces (AC4)
// ---------------------------------------------------------------------------

async function buildOverviewPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `<h1>Build</h1>
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
    <p class="muted">Agent creation is not exposed by the public API — the agents surface is read-only.</p>
  </section>
  <section class="tile">
    <h3><a href="/build/workload">Workload / Training</a></h3>
    <p>Training and batch compute as governed executions with budget and checkpoints.</p>
    <p class="muted">No public workload API yet.</p>
  </section>
  <section class="tile" id="deployments">
    <h3>Deployment</h3>
    <p>Persistent availability of an agent or program — distinct from individual executions.</p>
    <p class="muted">Deployment surfaces are not exposed by the public API yet.</p>
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
  "spendLimitDollars",
  "quality",
  "latencySeconds",
  "userId",
  "idempotencyKey",
];

function hiddenFields(values: Record<string, string>): string {
  return FORM_KEYS.filter((key) => key !== "idempotencyKey" || (values[key] ?? "").length > 0)
    .map((key) => `<input type="hidden" name="${key}" value="${esc(values[key] ?? "")}">`)
    .join("\n    ");
}

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
    const content = `<h1>Start an execution</h1>
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
    const content = `<h1>Start an execution</h1>
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
  const constraints = constraintSummary(query);
  const content = `<h1>Review the proposed execution</h1>
<div class="card">
  <h2>What you want</h2>
  <p>${esc(query.outcome ?? "")}</p>
  <h2>Scope</h2>
  ${keyValueTable([
    ["Application", query.applicationId ?? ""],
    [
      "Compute environment",
      (query.environmentId ?? "").length > 0 ? (query.environmentId ?? "") : "default",
    ],
    ["End user", (query.userId ?? "").length > 0 ? (query.userId ?? "") : "—"],
  ])}
  <h2>Targets</h2>
  ${
    constraints.length === 0
      ? '<p class="muted">No explicit constraints — Zeck will route within the governing policy.</p>'
      : `<ul>${constraints.map((line) => `<li>${line}</li>`).join("")}</ul>`
  }
  <p>Zeck will plan the route, run the work under the governing policy, verify it, and record the evidence. The route and plan are chosen by the platform — you review the request here before it runs.</p>
</div>
<form class="flow card" method="post" action="/build/execution">
    ${hiddenFields({ ...query, idempotencyKey })}
  <div class="form-actions">
    <button type="submit" class="primary">Execute</button>
    <a href="${esc(editLink(query, idempotencyKey))}">Edit these details</a>
  </div>
</form>
<p class="muted">Retrying this review (reloading, or submitting again) reuses the same idempotency key, so the platform converges on ONE execution rather than creating duplicates.</p>`;
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
    const content = `<h1>Start an execution</h1>
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
      const constraints = constraintSummary(ctx.form);
      const content = `<h1>Review the proposed execution</h1>
<div id="form-status" role="status" aria-live="polite" class="live-region">The platform rejected this request: ${esc(
        error.body.message,
      )} (${esc(error.body.code)})</div>
<div class="card">
  <h2>What you want</h2>
  <p>${esc(ctx.form.outcome ?? "")}</p>
  <h2>Scope</h2>
  ${keyValueTable([
    ["Application", ctx.form.applicationId ?? ""],
    [
      "Compute environment",
      (ctx.form.environmentId ?? "").length > 0 ? (ctx.form.environmentId ?? "") : "default",
    ],
  ])}
  <h2>Targets</h2>
  ${
    constraints.length === 0
      ? '<p class="muted">No explicit constraints.</p>'
      : `<ul>${constraints.map((line) => `<li>${line}</li>`).join("")}</ul>`
  }
</div>
<form class="flow card" method="post" action="/build/execution">
    ${hiddenFields({ ...ctx.form, idempotencyKey })}
  <div class="form-actions">
    <button type="submit" class="primary">Try again</button>
    <a href="${esc(editLink(ctx.form, idempotencyKey))}">Edit these details</a>
  </div>
</form>
<p class="muted">The same idempotency key is kept, so a retry converges on the governed outcome rather than creating a duplicate.</p>`;
      return htmlStatusResult(
        422,
        appShell({
          title: "Zeck — Review the proposed execution",
          activePath: "/build/execution",
          mainContent: content,
          appearance: appearanceOf(ctx.cookies),
          returnTo: ctx.path,
        }),
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Build: agent and workload (outcome-first entries, honest terminal states)
// ---------------------------------------------------------------------------

async function buildAgentPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const purpose = ctx.query.get("purpose") ?? "";
  const proposal =
    purpose.trim().length === 0
      ? ""
      : `<h2>Proposed design</h2>
<div class="card">
  ${keyValueTable([
    ["Purpose", purpose],
    ["Capabilities", "— described by you in the next step"],
    ["Tools", "— chosen after the capability set"],
    ["Guardrails", "— approval requirements set with policy"],
    ["Verification", "— checks the agent must pass"],
  ])}
  <p class="muted">This is the shape of the proposal Zeck will formalize when agent authoring ships.</p>
</div>`;
  const content = `<h1>Build an agent</h1>
<p>Agents are reusable execution systems. Start from the purpose; the design comes back as a proposal you can accept.</p>
<form class="flow card" method="get" action="/build/agent">
  <div class="form-field">
    <label for="agent-purpose">What are you building?</label>
    <textarea id="agent-purpose" name="purpose" placeholder="A support agent that handles incoming tickets and escalates billing disputes.">${esc(
      purpose,
    )}</textarea>
  </div>
  <div class="form-actions"><button type="submit">Propose the design</button></div>
</form>
${proposal}
${unavailableState(
  "Agent creation",
  "Agent creation is not exposed by the public API — the agents surface is read-only by design; create agents through your governed application path.",
  "an agent authoring surface over the agents authority",
)}
<p><a href="/agents">View the agent inventory (read-only)</a></p>`;
  return page(
    { title: "Zeck — Build an agent", activePath: "/build/agent", mainContent: content },
    ctx,
  );
}

async function buildWorkloadPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const purpose = ctx.query.get("purpose") ?? "";
  const content = `<h1>Build a workload</h1>
<p>Training and batch compute are governed executions in Zeck — budgeted, checkpointed and verified.</p>
<form class="flow card" method="get" action="/build/workload">
  <div class="form-field">
    <label for="workload-purpose">What should the workload do?</label>
    <textarea id="workload-purpose" name="purpose" placeholder="Train a classifier on this dataset with a $50 budget.">${esc(
      purpose,
    )}</textarea>
  </div>
  <div class="form-actions"><button type="submit">Sketch the workload</button></div>
</form>
${
  purpose.trim().length === 0
    ? ""
    : `<div class="card"><h2>Sketch</h2>${keyValueTable([
        ["Purpose", purpose],
        ["Dataset", "— attached when the surface ships"],
        ["Compute + budget", "— reserved before any paid step"],
        ["Checkpoints", "— content-addressed and resumable"],
      ])}</div>`
}
${unavailableState(
  "Workloads and training",
  "Training and batch compute run as governed executions, but no public workload API is exposed yet.",
  "a workload surface over governed executions",
)}
<p><a href="/build/execution">Run a one-off execution instead</a></p>`;
  return page(
    { title: "Zeck — Build a workload", activePath: "/build/workload", mainContent: content },
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
  const content = `<h1>Runs</h1>
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
  const content = `<h1>Active runs</h1>
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
  const content = `<h1>Run history</h1>
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
  const content = `<h1>Scheduled runs</h1>
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
</nav>`;
}

function notFoundExecutionView(executionId: string, ctx: HttpContext): HandlerResult {
  const content = `<h1>Execution not found</h1>
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
      returnTo: "/runs",
    }),
  );
}

function axisLabel(kind: string): string {
  switch (kind) {
    case "provider":
      return "Provider success";
    case "execution":
      return "Execution success";
    case "quality":
      return "Quality success";
    case "policy":
      return "Policy success";
    default:
      return kind;
  }
}

function activityView(
  execution: Execution,
  events: readonly ExecutionEvent[],
  view: string,
): string {
  const id = encodeURIComponent(execution.id);
  const viewLinks = `<p class="muted">Advanced views: <a href="/runs/${id}?tab=activity&amp;view=events">raw events</a> · <a href="/runs/${id}?tab=activity&amp;view=raw">raw payloads</a> · <a href="/runs/${id}?tab=activity">timeline</a></p>`;
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
${viewLinks}
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
${viewLinks}
${
  events.length === 0
    ? emptyState("No events", "The public event stream is empty for this execution.")
    : blocks
}`;
  }
  return `<h2>Activity</h2>
${progressTimeline(events)}
${advancedDisclosure(
  "Advanced activity views",
  `${viewLinks}
${emptyState(
  "Graph view",
  "The execution graph view is an expert surface; the public projection exposes the chronological timeline and raw events.",
)}`,
)}`;
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
  const header = executionHeader({
    execution,
    durationMs: durationMs(execution.createdAt, execution.terminalAt, Date.now()),
    costMicroUsd: result.cost === null ? null : result.cost.totalMicroUsd,
    verificationChip: deriveVerificationChip(result.verification),
  });
  if (ctx.query.get("action") === "cancel" && !isTerminal(execution.status)) {
    const content = `${header}
${whyPanel({ execution, result, events })}
<section class="card">
  <h2>Cancel this execution?</h2>
  <p><strong>Consequence:</strong> cancelling stops the execution at its current state. Work already performed is kept and stays inspectable; the execution moves to the terminal state Cancelled and cannot be resumed.</p>
  <p><strong>Authorization:</strong> this is the governed cancel command — it goes through the platform's execution lifecycle authority, which validates it.</p>
  <p>Current status: ${statusBadge(execution.status)}</p>
  <form method="post" action="/runs/${encodeURIComponent(execution.id)}/cancel">
    <input type="hidden" name="idempotencyKey" value="dash-${esc(crypto.randomUUID())}">
    <div class="form-actions">
      <button type="submit" class="danger">Cancel execution</button>
      <a href="/runs/${encodeURIComponent(execution.id)}">Keep it running</a>
    </div>
  </form>
  <p class="muted">The confirmation carries an idempotency key, so a double submit converges on one cancellation.</p>
</section>`;
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
  const tab = tabParam === "evidence" || tabParam === "activity" ? tabParam : "result";
  const viewParam = ctx.query.get("view") ?? "";
  const view = viewParam === "events" || viewParam === "raw" ? viewParam : "";
  let panel: string;
  if (tab === "evidence") {
    const verification = await client.listVerification(executionId);
    const axes = deriveTrustAxes(execution, result, events);
    const axesRows = axes
      .map(
        (axis) => `<tr>
      <th scope="row">${esc(axisLabel(axis.kind))}</th>
      <td>${esc(axis.label)}<br><span class="muted">${esc(axis.detail)}</span></td>
      <td class="mono">${esc(axis.source)}</td>
    </tr>`,
      )
      .join("");
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
    panel = `<h2>Evidence</h2>
<table class="data">
  <thead><tr><th scope="col">Trust axis</th><th scope="col">What the platform records</th><th scope="col">Fact source</th></tr></thead>
  <tbody>${axesRows}</tbody>
</table>
<p class="muted">The four axes are separate facts — they are never merged into a single score.</p>
<h3>Verification results</h3>
${verificationSummary(verification, { executionId: execution.id })}
<h3>Provenance</h3>
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
  } else {
    panel = `<h2>Result</h2>
${resultSurface({ execution, result, events })}`;
  }
  const content = `${header}
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
  const content = `<h1>Agents</h1>
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
  const content = `<h1>${esc(status.agent.name)}</h1>
<p>${
    status.agent.description === null
      ? '<span class="muted">No description recorded.</span>'
      : esc(status.agent.description)
  }</p>
<p>${agentStatusBadge(status.agent.status)}</p>
<h2>Facts</h2>
${keyValueTable([
  ["slug", status.agent.slug],
  ["id", status.agent.id],
  ["active version", status.agent.activeVersion ?? "—"],
  ["created", status.agent.createdAt],
  ["updated", status.agent.updatedAt],
])}
<h3>Active version</h3>
${
  status.activeVersion === null
    ? '<p class="muted">No active version is selected.</p>'
    : keyValueTable([
        ["version", status.activeVersion.version],
        ["definition digest", status.activeVersion.definitionDigest],
        ["validation state", status.activeVersion.validationState],
        ["validation notes", status.activeVersion.validationNotes ?? "—"],
        ["created", status.activeVersion.createdAt],
      ])
}
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
${selection}`,
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
  const content = `<h1>Artifacts</h1>
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

async function artifactDetailPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const artifactId = ctx.params.artifactId ?? "";
  const executionId = ctx.query.get("executionId");
  let contextBlock = "";
  if (executionId !== null && executionId.length > 0) {
    try {
      const [execution, result] = await Promise.all([
        client.getExecution(executionId),
        client.getResult(executionId),
      ]);
      const match = result.outputArtifacts.find((artifact) => artifact.id === artifactId);
      contextBlock = `<h2>Producing execution</h2>
${keyValueTable([
  ["execution", execution.id],
  ["outcome", executionTitle(execution.task, execution.id)],
  ["status", `${currentStageLabel(execution.status)} (${execution.status})`],
  ["digest", match === undefined || match.digest === null ? "—" : match.digest],
  ["created", match === undefined ? "—" : match.createdAt],
])}
<div class="actions"><a href="/runs/${encodeURIComponent(execution.id)}">Open the execution result</a></div>`;
    } catch (error) {
      if (!(error instanceof ZeckApiError && error.status === 404)) {
        throw error;
      }
      contextBlock = `<h2>Producing execution</h2>
${errorState(
  "The producing execution is not visible",
  `No execution "${executionId}" was returned — it may belong to another application or not exist.`,
)}`;
    }
  }
  const content = `<h1>Artifact</h1>
<p class="muted mono">${esc(artifactId)}</p>
${contextBlock}
${unavailableState(
  "Artifact content and lineage",
  "Artifact content, metadata and lineage are not exposed by the public API — artifacts cross the wire only as id/digest/createdAt references on execution results.",
  "an artifact content and lineage projection",
)}`;
  return page(
    { title: "Zeck — Artifact", activePath: "/assets/artifacts", mainContent: content },
    ctx,
  );
}

async function competencesPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `<h1>Competences</h1>
${unavailableState(
  "Competences",
  "A competence is a reusable, evidence-backed way of describing work Zeck knows how to perform — with success rate, typical cost and verification checks. None of that is exposed by the public API yet.",
  "the competence authority through the public API",
)}`;
  return page(
    { title: "Zeck — Competences", activePath: "/assets/competences", mainContent: content },
    ctx,
  );
}

async function competenceDetailPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `<h1>Competence</h1>
<p class="muted mono">${esc(ctx.params.competenceId ?? "")}</p>
${unavailableState(
  "Competence detail",
  "Competence procedures, success rates and costs are not exposed by the public API yet.",
  "the competence authority through the public API",
)}`;
  return page(
    { title: "Zeck — Competence", activePath: "/assets/competences", mainContent: content },
    ctx,
  );
}

async function connectionsPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const content = `<h1>Connections</h1>
${unavailableState(
  "Connections",
  "External tool and data connections are governed server-side; the public API does not expose a connections surface.",
  "a connections projection over the integrations authority",
)}
<p class="muted">Secret safety: connection credentials are never rendered anywhere in this dashboard — there is no field where a secret could appear.</p>`;
  return page(
    { title: "Zeck — Connections", activePath: "/assets/connections", mainContent: content },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Improve and Admin (AC5) — honest unavailable states
// ---------------------------------------------------------------------------

interface StaticPage {
  readonly title: string;
  readonly h1: string;
  readonly activePath: string;
  readonly concept: string;
  readonly explanation: string;
  readonly futureSource: string;
}

const STATIC_PAGES: readonly (readonly [string, StaticPage])[] = [
  [
    "/improve/evaluations",
    {
      title: "Zeck — Evaluations",
      h1: "Evaluations",
      activePath: "/improve/evaluations",
      concept: "Evaluations",
      explanation:
        "Evaluations are the records behind quality claims — scored runs over defined datasets. The public API does not expose an evaluations surface yet.",
      futureSource: "the evaluation authority through the public API",
    },
  ],
  [
    "/improve/insights",
    {
      title: "Zeck — Insights",
      h1: "Insights",
      activePath: "/improve/insights",
      concept: "Insights",
      explanation:
        "Insights are recommendations to improve your workflows — each with observed evidence, expected impact and confidence. The public API does not expose an insights surface yet.",
      futureSource: "the learning authority through the public API",
    },
  ],
  [
    "/improve/learning",
    {
      title: "Zeck — Learning",
      h1: "Learning",
      activePath: "/improve/learning",
      concept: "Learning",
      explanation:
        "Learning telemetry powers Zeck's recommendations. The public API does not expose a learning surface yet.",
      futureSource: "the learning authority through the public API",
    },
  ],
  [
    "/admin/policies",
    {
      title: "Zeck — Policies",
      h1: "Policies",
      activePath: "/admin/policies",
      concept: "Policies and controls",
      explanation:
        "Controls in user language: quality targets, cost limits per execution, latency limits, data regions, allowed external tools, and approval requirements for external side effects. The effective values are not exposed by the public API yet.",
      futureSource: "the policy authority through the public API",
    },
  ],
  [
    "/admin/budgets",
    {
      title: "Zeck — Budgets",
      h1: "Budgets",
      activePath: "/admin/budgets",
      concept: "Budgets and spend",
      explanation:
        "Spend management: monthly spend, remaining budget and the breakdown across executions, agents and training. The values are not exposed by the public API yet.",
      futureSource: "the budgets authority through the public API",
    },
  ],
  [
    "/admin/team",
    {
      title: "Zeck — Team",
      h1: "Team",
      activePath: "/admin/team",
      concept: "Team",
      explanation:
        "Workspace members, roles and approval responsibilities. The public API does not expose a team surface yet.",
      futureSource: "the membership authority through the public API",
    },
  ],
  [
    "/admin/environments",
    {
      title: "Zeck — Environments",
      h1: "Environments",
      activePath: "/admin/environments",
      concept: "Compute environments",
      explanation:
        "Compute environments (substrates) that executions run in. The public API does not expose an environments surface yet; executions carry only their environment id.",
      futureSource: "the compute environment authority through the public API",
    },
  ],
  [
    "/admin/audit",
    {
      title: "Zeck — Audit",
      h1: "Audit",
      activePath: "/admin/audit",
      concept: "Audit",
      explanation:
        "Audit records over governed actions. The public API does not expose an audit surface yet; per-execution events are the closest live record.",
      futureSource: "the audit authority through the public API",
    },
  ],
];

function staticPageOf(path: string): StaticPage {
  const entry = STATIC_PAGES.find(([key]) => key === path);
  if (entry === undefined) {
    throw new Error(`no static page registered for ${path}`);
  }
  return entry[1];
}

function staticUnavailablePage(pageInfo: StaticPage, ctx: HttpContext): HandlerResult {
  const content = `<h1>${esc(pageInfo.h1)}</h1>
${unavailableState(pageInfo.concept, pageInfo.explanation, pageInfo.futureSource)}`;
  return page(
    { title: pageInfo.title, activePath: pageInfo.activePath, mainContent: content },
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
    const content = `<h1>Command</h1>
<p>Search and command Zeck from anywhere: navigation, executions, agents and proposed actions.</p>
<h2>How it works</h2>
<ul>
  <li>Press <kbd>Ctrl</kbd>+<kbd>K</kbd> (or <kbd>⌘</kbd>+<kbd>K</kbd>) to focus the command bar.</li>
  <li>Type an execution id to open it directly.</li>
  <li>Mutations are never performed from here — they are proposed as links into their confirmation flows.</li>
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
    .map(
      (match) =>
        `<li><a href="${esc(match.href)}">${esc(match.label)}</a><span class="result-kind">${esc(
          match.kind,
        )}</span></li>`,
    )
    .join("\n  ");
  const content = `<h1>Command</h1>
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
// Appearance (no-script fallback) and static assets
// ---------------------------------------------------------------------------

async function appearancePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  void client;
  const mode = ctx.query.get("mode") ?? "system";
  const returnTo = ctx.query.get("returnTo") ?? "/";
  const safeMode: Appearance = mode === "light" || mode === "dark" ? mode : "system";
  const safeReturnTo = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
  return redirectResult(safeReturnTo, { setCookies: [appearanceCookieHeader(safeMode)] });
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
    wrap("GET", "/improve/evaluations", (ctx) =>
      staticUnavailablePage(staticPageOf("/improve/evaluations"), ctx),
    ),
    wrap("GET", "/improve/insights", (ctx) =>
      staticUnavailablePage(staticPageOf("/improve/insights"), ctx),
    ),
    wrap("GET", "/improve/learning", (ctx) =>
      staticUnavailablePage(staticPageOf("/improve/learning"), ctx),
    ),
    wrap("GET", "/admin/policies", (ctx) =>
      staticUnavailablePage(staticPageOf("/admin/policies"), ctx),
    ),
    wrap("GET", "/admin/budgets", (ctx) =>
      staticUnavailablePage(staticPageOf("/admin/budgets"), ctx),
    ),
    wrap("GET", "/admin/team", (ctx) => staticUnavailablePage(staticPageOf("/admin/team"), ctx)),
    wrap("GET", "/admin/environments", (ctx) =>
      staticUnavailablePage(staticPageOf("/admin/environments"), ctx),
    ),
    wrap("GET", "/admin/audit", (ctx) => staticUnavailablePage(staticPageOf("/admin/audit"), ctx)),
    wrap("GET", "/command", (ctx) => commandPage(client, ctx)),
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
