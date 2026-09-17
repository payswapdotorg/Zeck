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
  type ExecutionRequest,
  type ExecutionResult,
  type VerificationResult,
  ZeckApiError,
  type ZeckClient,
} from "../../sdk";
import { attentionArea, attentionSummary } from "./attention";
import { CLIENT_SCRIPT } from "./client";
import {
  compareBaselineLaunchHandler,
  compareConsolePage,
  compareFactsRoute,
  compareLinkOf,
} from "./compare";
import {
  distinctionList,
  esc,
  executionHeader,
  formatDuration,
  formatMicroUsd,
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
  type ConsoleFamily,
  capabilityKinds,
  classificationChip,
  consoleApplicationsOf,
  consoleFamilies,
  developerDocsIndex,
  evidenceKinds,
  familiesByClassification,
  familyAvailabilitySection,
  familyOf,
  inFlightCount,
  PLAYGROUND_BUDGET_LIMIT_DOLLARS,
  PLAYGROUND_LATENCY_LIMIT_MS,
  PLAYGROUND_MAX_CONCURRENT_RUNS,
  PLAYGROUND_ORIGIN,
  playgroundTaskTable,
  readDeveloperDoc,
  sandboxLimitsSection,
  seedCapabilities,
} from "./console";
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
import {
  type CredentialConsoleTransport,
  credentialMutationUnavailableContent,
  credentialReplayContent,
  credentialRevealContent,
  credentialsSections,
  credentialTransportFromEnvironment,
  validateCredentialIssueForm,
} from "./credentials";
import { advancedDisclosure } from "./disclosure";
import {
  type ExplorerFacts,
  type ExplorerRunFact,
  explorerFactsOf,
  explorerFamilyOf,
  explorerListFactsJson,
  explorerNotFoundView,
  explorerRunsOf,
  explorerTabNav,
  explorerView,
  explorerViewOf,
} from "./explorer";
import {
  executionExportView,
  explorerExportAction,
  exportNotFoundView,
  reproducibilityBundleOf,
} from "./export";
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
import { type ExperienceMode, modeCookieHeader, modeOf, modeSelectionForm } from "./modes";
import {
  buildInteractiveRunRequest,
  type ComposerField,
  composedTaskOf,
  composerSchemaOf,
  corpusTaskCountOf,
  defaultTaskFormValuesOf,
  exampleOfFamily,
  familyIsHardBlocked,
  formKeyOf,
  interactiveFormKeysOf,
  type PlaygroundRunFact,
  playgroundAvailabilityOf,
  playgroundRunsForFamily,
  readPlaygroundExampleSource,
  validateInteractiveRunForm,
} from "./playground";
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
import {
  quotaDimensionLabel,
  quotaProgressOf,
  type SandboxGovernanceTransport,
  type SandboxIdentityFact,
  type SandboxQuotaFact,
  type SyntheticDataPolicyFact,
  sandboxGovernanceTransportFromEnvironment,
} from "./sandbox-governance";
import {
  type Appearance,
  type AppShellInput,
  appShell,
  navIndex,
  pageHead,
  renderAppearanceForm,
} from "./shell";
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
import { usageBudgetsTransportFromEnvironment, usageConsolePage, usageFactsRoute } from "./usage";
import {
  agentSchemaJson,
  availabilityOf,
  buildValidationRunRequest,
  capabilityMatrixRows,
  defaultTaskOf,
  experimentDefinitionJson,
  experimentIsRerunnable,
  experimentOf,
  experimentsByStage,
  familyTaskCountOf,
  notRunBoundaries,
  providerAccessRows,
  providerCoverageRows,
  readValidationEvidence,
  recommendedExperiments,
  reproducibilityBundleJson,
  runRecordJson,
  sdkExampleOf,
  tasksOfExperiment,
  unissuedValidationIds,
  VALIDATION_BUDGET_LIMIT_DOLLARS,
  VALIDATION_BUDGET_LIMIT_MICRO_USD,
  VALIDATION_FORM_KEYS,
  VALIDATION_LAB_ORIGIN,
  VALIDATION_LATENCY_LIMIT_MS,
  VALIDATION_MAX_CONCURRENT_RUNS,
  VALIDATION_RUN_MODES,
  type ValidationExperiment,
  validateValidationRunForm,
  validationCatalogJson,
  validationComparisonOf,
  validationExperiments,
  validationRunsForWorkOrder,
} from "./validation-lab";

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
  /**
   * WORK-041 (performance — semantics-preserving): the recents reads fan
   * out concurrently. The read SET is identical to the sequential form
   * (exactly one governed getExecution per recents id, results kept in the
   * recents order), a 404 still prunes exactly that id, and every other
   * error still propagates fail-closed to the router's error surfaces —
   * only wall-clock time changes, so primary journeys stay fast as the
   * recents list fills (the domain semantics are untouched).
   */
  const reads = await Promise.all(
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
  const executions = reads.filter((execution): execution is Execution => execution !== null);
  const pruned = executions.length !== ids.length;
  return { executions, survivingIds: executions.map((execution) => execution.id), pruned };
}

function lookupForm(): string {
  return `<form method="get" action="/executions" class="flow card">
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
  // DEP-033 (accessibility hardening): the error reference belongs on the
  // CONTROL (aria-describedby on the input/select/textarea announces the
  // field error when focus lands there) — never on the label, where it
  // carried no meaning for assistive technology. Every caller builds the
  // control markup with `id="<id>"` as its first attribute, so the
  // association is injected there.
  const control =
    error === undefined
      ? input
      : input.replace(` id="${id}"`, ` id="${id}" aria-describedby="${id}-error"`);
  return `<div class="form-field">
  <label for="${id}">${esc(label)}</label>
  ${control}
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
  // DEP-033 (accessibility hardening): same rule as executionFormField —
  // the error reference rides on the control, not the label.
  const control =
    error === undefined
      ? input
      : input.replace(` id="${id}"`, ` id="${id}" aria-describedby="${id}-error"`);
  return `<div class="form-field">
  <label for="${id}">${esc(label)}</label>
  ${control}
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
   *
   * CORRECTION (the Architect review of PR #72): the events read is
   * fail-closed EXACTLY like every other dashboard read — only the 404
   * absence of an event stream renders as "no session facts" for that
   * run; every other failure (scope/auth/transport/422) PROPAGATES to
   * the router's error surfaces and never becomes a successful-looking
   * page (never a swallowed empty session projection).
   */
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const sessionRuns: {
    readonly executionId: string;
    readonly sessionCount: number;
    readonly lastActivity: string | null;
  }[] = [];
  // WORK-041 (performance — semantics-preserving fan-out): the per-run
  // event reads run concurrently; the read set, the 404-only absence and
  // the fail-closed propagation are identical to the sequential form.
  const eventsPerRun: readonly (readonly ExecutionEvent[])[] = await Promise.all(
    recents.executions.map(async (execution) => {
      try {
        return await client.listEvents(execution.id);
      } catch (error) {
        if (error instanceof ZeckApiError && error.status === 404) {
          // A 404 event stream is the honest absence: the run exists but
          // contributes no session facts — the row's absence is truthful.
          return [] as readonly ExecutionEvent[];
        }
        throw error;
      }
    }),
  );
  recents.executions.forEach((execution, index) => {
    const sessionFacts = agentSessionFactsOf(eventsPerRun[index] ?? []);
    if (sessionFacts.present) {
      sessionRuns.push({
        executionId: execution.id,
        sessionCount: sessionFacts.sessionCount,
        lastActivity: sessionFacts.events[sessionFacts.events.length - 1]?.occurredAt ?? null,
      });
    }
  });
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
      // WORK-041 (context restoration): the same foundation rule as every
      // content page — a preference change on this view returns to THIS
      // view (re-rendered in the new presentation), never a bounce that
      // loses the user's place. The lookup form above is the recovery path.
      returnTo: ctx.path,
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
  // WORK-041 (performance — semantics-preserving fan-out): the per-run
  // result reads run concurrently (no 404-catch here, exactly as before —
  // an error on any recents result read propagates to the router's error
  // surfaces); the read set is identical to the sequential form.
  const resultsPerRun = await Promise.all(
    recents.executions.map((execution) => client.getResult(execution.id)),
  );
  recents.executions.forEach((execution, index) => {
    const result = resultsPerRun[index];
    if (result === undefined || result.outputArtifacts.length === 0) {
      return;
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
  });
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
  const usages: ArtifactUsageRow[] =
    // WORK-041 (performance — semantics-preserving fan-out): the per-id
    // execution+event reads run concurrently; the read set, the 404-only
    // skip and the fail-closed propagation are identical to the sequential
    // form.
    (
      await Promise.all(
        ids
          .filter((id) => id !== excludeExecutionId)
          .map(async (id): Promise<ArtifactUsageRow | null> => {
            try {
              const [execution, events] = await Promise.all([
                client.getExecution(id),
                client.listEvents(id),
              ]);
              if (consumesArtifact(events, artifactId)) {
                return { executionId: id, title: executionTitle(execution.task, id) };
              }
              return null;
            } catch (error) {
              if (error instanceof ZeckApiError && error.status === 404) {
                return null;
              }
              throw error;
            }
          }),
      )
    ).filter((usage): usage is ArtifactUsageRow => usage !== null);
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
  // WORK-041 (performance — semantics-preserving fan-out): the per-run
  // result reads run concurrently; the 404 absence keeps the honest
  // "No verification results" chip and zero artifact count, every other
  // error propagates fail-closed.
  const resultsPerRun = await Promise.all(
    recents.executions.map(async (execution) => {
      try {
        return await client.getResult(execution.id);
      } catch (error) {
        if (error instanceof ZeckApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    }),
  );
  recents.executions.forEach((execution, index) => {
    const result = resultsPerRun[index] ?? null;
    const chip =
      result === null ? "No verification results" : deriveVerificationChip(result.verification);
    const artifactsCount = result === null ? 0 : result.outputArtifacts.length;
    const id = encodeURIComponent(execution.id);
    sections.push(`<li>
  <a class="run-title" href="/runs/${id}?tab=evidence">${esc(
    executionTitle(execution.task, execution.id),
  )}</a>
  ${statusBadge(execution.status)}
  <span class="axis-fact">${esc(chip)}</span>
  <a href="/runs/${id}">Result</a> · <a href="/runs/${id}?tab=activity">Activity</a> · <a href="/assets/artifacts">Artifacts (${artifactsCount})</a>
</li>`);
  });
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
  // WORK-041 (performance — semantics-preserving fan-out): the per-run
  // event+result reads run concurrently; the read set, the 404-only
  // absence and the fail-closed propagation are identical to the
  // sequential form.
  const factsPerRun: readonly {
    readonly inputRefs: readonly string[];
    readonly outputs: readonly { id: string; digest: string | null }[];
  }[] = await Promise.all(
    recents.executions.map(
      async (
        execution,
      ): Promise<{
        inputRefs: readonly string[];
        outputs: readonly { id: string; digest: string | null }[];
      }> => {
        try {
          const [events, result] = await Promise.all([
            client.listEvents(execution.id),
            client.getResult(execution.id),
          ]);
          return { inputRefs: inputArtifactRefsOf(events), outputs: result.outputArtifacts };
        } catch (error) {
          if (error instanceof ZeckApiError && error.status === 404) {
            return { inputRefs: [], outputs: [] };
          }
          throw error;
        }
      },
    ),
  );
  recents.executions.forEach((execution, index) => {
    const facts = factsPerRun[index] ?? {
      inputRefs: [] as readonly string[],
      outputs: [] as readonly { id: string; digest: string | null }[],
    };
    const { inputRefs, outputs } = facts;
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
  });
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
  // WORK-041 (performance — semantics-preserving fan-out): the per-run
  // event reads run concurrently; the read set, the 404-only absence and
  // the fail-closed propagation are identical to the sequential form.
  const eventsPerRun: readonly (readonly ExecutionEvent[])[] = await Promise.all(
    recents.executions.map(async (execution) => {
      try {
        return await client.listEvents(execution.id);
      } catch (error) {
        if (error instanceof ZeckApiError && error.status === 404) {
          return [] as readonly ExecutionEvent[];
        }
        throw error;
      }
    }),
  );
  recents.executions.forEach((execution, index) => {
    const denial = policyDenialOf(eventsPerRun[index] ?? []);
    if (denial !== null) {
      blocked.push({
        id: execution.id,
        title: executionTitle(execution.task, execution.id),
        status: execution.status,
        denial,
      });
    }
  });
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
  // WORK-041 (performance — semantics-preserving fan-out): the per-run
  // result reads run concurrently; the 404 absence keeps the honest
  // synthetic unsettled view, every other error propagates fail-closed.
  facts.push(
    ...(await Promise.all(
      recents.executions.map(async (execution): Promise<RunSpendFact> => {
        let result: ExecutionResult;
        try {
          result = await client.getResult(execution.id);
        } catch (error) {
          if (error instanceof ZeckApiError && error.status === 404) {
            // No result package yet (the run has not settled): the run
            // still renders — its declared limit from the execution
            // record, the honest "not settled yet" for cost, no invented
            // route.
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
        return runSpendFacts(execution, result);
      }),
    )),
  );
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
  // WORK-041 (performance — semantics-preserving fan-out): the per-run
  // result reads run concurrently; the 404 absence keeps the honest
  // synthetic unsettled view, every other error propagates fail-closed.
  facts.push(
    ...(await Promise.all(
      recents.executions.map(async (execution): Promise<RunSpendFact> => {
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
        return runSpendFacts(execution, result);
      }),
    )),
  );
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
  const rows: AuditLedgerRow[] =
    // WORK-041 (performance — semantics-preserving fan-out): the per-run
    // event reads run concurrently; the read set, the 404-only absence and
    // the fail-closed propagation are identical to the sequential form.
    (
      await Promise.all(
        recents.executions.map(async (execution): Promise<AuditLedgerRow | null> => {
          let events: readonly ExecutionEvent[] = [];
          try {
            events = await client.listEvents(execution.id);
          } catch (error) {
            if (!(error instanceof ZeckApiError && error.status === 404)) {
              throw error;
            }
          }
          if (events.length === 0) {
            return null;
          }
          const ordered = chronologicalEvents(events);
          const last = ordered[ordered.length - 1];
          return {
            executionId: execution.id,
            eventCount: events.length,
            lastEventAt: last?.occurredAt ?? null,
            lastEventLabel: last === undefined ? null : eventStageLabel(last.type),
          };
        }),
      )
    ).filter((row): row is AuditLedgerRow => row !== null);
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
    ? // WORK-041 (states consistency): the no-match state composes the
      // ONE empty-state primitive — the same vocabulary and the same
      // single escape boundary every other route uses (the query passes
      // through esc inside the primitive, never hand-rolled markup).
      emptyState(
        `No matches for "${query}"`,
        'Try a navigation word (agents, runs, policies), an execution id, or a phrase like "cancel <execution id>".',
      )
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
// Developer console (DEP-010 — the roadmap-governed console surfaces)
// ---------------------------------------------------------------------------

/**
 * The applications-section tab nav (Overview / API keys / Environments /
 * Usage). Static routes are registered before the parameterized
 * application detail route, so these paths always win.
 */
function applicationsTabNav(active: string): string {
  const tab = (name: string, label: string, href: string): string =>
    `<a href="${esc(href)}"${active === name ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<nav class="tabs" aria-label="Application views">
  ${tab("", "Overview", "/console/applications")}
  ${tab("keys", "API keys", "/console/applications/keys")}
  ${tab("environments", "Environments", "/console/applications/environments")}
  ${tab("usage", "Usage", "/console/applications/usage")}
</nav>`;
}

async function consoleHomePage(scope: string, ctx: HttpContext): Promise<HandlerResult> {
  const scopeLine =
    scope.length > 0
      ? `This console is bound to the application scope <span class="mono">${esc(
          scope,
        )}</span> — every scoped read and governed command it sends carries that selector, and the effective scope is still derived server-side.`
      : "This console has no bound application scope in its deployment configuration — set ZECK_APPLICATION_ID where the console runs.";
  const content = `${pageHead({
    title: "Developer console",
    path: "/console",
    primaryActionHtml:
      '<a class="button-link primary" href="/console/playground">Open the playground</a>',
  })}
<p>${scopeLine}</p>
<div class="tiles">
  <section class="tile">
    <h3><a href="/console/quickstart">Quickstart</a></h3>
    <p>The five-step guided path to a first sandbox execution and its evidence.</p>
    <p class="muted">Live — the guided console path.</p>
  </section>
  <section class="tile">
    <h3><a href="/console/applications">Applications</a></h3>
    <p>Application scope, safe credentials, environments and usage.</p>
    <p class="muted">Scope is live; inventory and issuance are honest not-exposed states (no public API yet).</p>
  </section>
  <section class="tile">
    <h3><a href="/console/playground">Playground</a></h3>
    <p>Guided sandbox runs for every workload family — synthetic data, hard limits, honest availability.</p>
    <p class="muted">Live — every run goes through the governed public API; live completion depends on the deployment's authorized rails.</p>
  </section>
  <section class="tile">
    <h3><a href="/runs">Executions</a></h3>
    <p>The execution explorer: result, verification, activity, route and cost.</p>
    <p class="muted">Live — the run surface this console already projects.</p>
  </section>
  <section class="tile">
    <h3><a href="/trust/evidence">Evidence</a></h3>
    <p>Verification evidence behind every run.</p>
    <p class="muted">Live per run; cross-work evidence search is not public yet.</p>
  </section>
  <section class="tile">
    <h3><a href="/assets/artifacts">Artifacts</a></h3>
    <p>Output artifacts of executions you open, with digest and lineage.</p>
    <p class="muted">Live — per-execution facts.</p>
  </section>
  <section class="tile">
    <h3><a href="/admin/budgets">Costs</a></h3>
    <p>Per-run spend, limits and categories.</p>
    <p class="muted">Live — browser-scoped per-run facts; no aggregate economics API yet.</p>
  </section>
  <section class="tile">
    <h3><a href="/console/providers">Providers &amp; capabilities</a></h3>
    <p>The capability catalog and honest provider availability.</p>
    <p class="muted">Live — projected from the machine capability manifest.</p>
  </section>
  <section class="tile">
    <h3><a href="/console/docs">Docs</a></h3>
    <p>The developer documentation, served from the repository.</p>
    <p class="muted">Live — the public integration kit, verbatim.</p>
  </section>
  <section class="tile">
    <h3><a href="/console/settings">Settings</a></h3>
    <p>Console presentation preferences and the disclosed recents list.</p>
    <p class="muted">Live — presentation state only.</p>
  </section>
</div>`;
  return page(
    { title: "Zeck — Developer console", activePath: "/console", mainContent: content },
    ctx,
  );
}

async function quickstartPage(scope: string, ctx: HttpContext): Promise<HandlerResult> {
  const content = `${pageHead({
    title: "Quickstart",
    path: "/console/quickstart",
    primaryActionHtml:
      '<a class="button-link primary" href="/console/playground/text">Run the first sandbox execution</a>',
  })}
<p>Five steps from zero to an inspectable sandbox execution — every step is a link into a live console surface, and every step states honestly what the platform exposes.</p>
<ol class="steps">
  <li>
    <p><strong>Your application scope.</strong> ${
      scope.length > 0
        ? `This console is already bound to <span class="mono">${esc(scope)}</span> — the governed scope every run here belongs to.`
        : "This console has no bound scope in its deployment configuration; the create surfaces ask for the application id per request."
    } <a href="/console/applications">Applications</a> shows what the console derives and what only the platform authority owns.</p>
  </li>
  <li>
    <p><strong>A safe credential.</strong> The console's transport credential is bound from the environment at startup and is never displayed, logged or stored in a cookie. Provider keys are bring-your-own, secret-mediated server-side — the SDK surface has no field where a plaintext secret could appear. <a href="/console/applications/keys">API keys &amp; credentials</a> states the full policy and the guided path.</p>
  </li>
  <li>
    <p><strong>Run your first sandbox execution.</strong> The <a href="/console/playground/text">playground's text family</a> submits the canonical synthetic summarization task through the governed public API with a hard budget, latency ceiling and disposable-sandbox identity — no provider, model or connection is ever selected.</p>
  </li>
  <li>
    <p><strong>Inspect the full path.</strong> The <a href="/runs">execution explorer</a> shows the result, verification evidence, the activity timeline, the recorded route and the settled cost — every field a public-contract fact. <a href="/trust/evidence">Evidence</a> and <a href="/assets/artifacts">artifacts</a> drill deeper.</p>
  </li>
  <li>
    <p><strong>Go deeper.</strong> The <a href="/console/docs">docs</a> cover every workload family, the SDK, the sandbox limits, webhooks and the production promotion path — readable by humans and coding agents alike.</p>
  </li>
</ol>
${sandboxLimitsSection()}`;
  return page(
    { title: "Zeck — Quickstart", activePath: "/console/quickstart", mainContent: content },
    ctx,
  );
}

async function applicationsPage(
  client: ZeckClient,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const applications = consoleApplicationsOf(recents.executions);
  const rows =
    applications.length === 0
      ? emptyState(
          "No applications seen yet",
          "The public API exposes no application listing route. Applications appear here as their executions are opened in this browser — the console holds no application registry of its own.",
        )
      : `<table class="data">
  <thead><tr><th scope="col">Application</th><th scope="col">Runs opened</th><th scope="col">Last seen</th></tr></thead>
  <tbody>${applications
    .map(
      (application) => `<tr>
      <td class="mono"><a href="/console/applications/${encodeURIComponent(
        application.applicationId,
      )}">${esc(application.applicationId)}</a></td>
      <td>${esc(application.runCount)}</td>
      <td class="mono">${esc(application.lastSeenAt)}</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
  const content = `${pageHead({
    title: "Applications",
    path: "/console/applications",
    primaryActionHtml:
      '<a class="button-link" href="/build/execution">Start an execution for an application</a>',
  })}
${applicationsTabNav("")}
<h2>This console's scope</h2>
${keyValueTable([
  [
    "Console application scope",
    scope.length > 0 ? scope : "(not bound — set ZECK_APPLICATION_ID where the console runs)",
  ],
  [
    "Where it comes from",
    "deployment configuration (ZECK_APPLICATION_ID); the SDK client sends it as the X-Zeck-Application header on every scoped read and governed command",
  ],
  [
    "Who derives the effective scope",
    "the platform, server-side, from durable membership rows — the header names, it never authorizes",
  ],
])}
<h2>Applications on recent executions</h2>
<p class="muted">${esc(RECENTS_NOTE)}.</p>
${rows}
${unavailableState(
  "Application inventory and creation",
  "There is no application inventory or creation route in the public API — the application authority owns application lifecycle, and the console must not become a second one. Executions are created per request with an explicit applicationId (the create contract's split selector), and the applications above are derived live from executions this browser opened.",
  "the application authority through the public API",
)}
<p>Guided path: <a href="/console/docs/AUTH.md">authentication and application setup</a> in the docs.</p>`;
  return page(
    { title: "Zeck — Applications", activePath: "/console/applications", mainContent: content },
    ctx,
    { setCookies },
  );
}

async function applicationDetailPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const applicationId = ctx.params.applicationId ?? "";
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const mine = recents.executions.filter((execution) => execution.applicationId === applicationId);
  const facts = consoleApplicationsOf(mine)[0] ?? null;
  const content = `${pageHead({
    title: "Application",
    path: "/console/applications",
    currentLabel: applicationId,
  })}
${applicationsTabNav("")}
<h2>Application facts</h2>
${
  facts === null
    ? emptyState(
        "No executions of this application were opened in this browser",
        "The public API exposes no application record route — application facts here are derived live from executions this browser opened.",
      )
    : keyValueTable([
        ["Application", facts.applicationId],
        ["Runs opened in this browser", String(facts.runCount)],
        ["Last seen", facts.lastSeenAt],
      ])
}
<h2>Runs</h2>
${runsList(mine, "No executions of this application were opened in this browser yet.")}
<p class="muted">These are browser-scoped facts (${esc(RECENTS_NOTE)}) — the application authority owns the durable record, and no application read API is public yet.</p>`;
  return page(
    {
      title: `Zeck — Application ${applicationId}`,
      activePath: "/console/applications",
      mainContent: content,
    },
    ctx,
    { setCookies },
  );
}

async function credentialsPage(
  credentials: CredentialConsoleTransport | null,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  // DEP-011: the real credential lifecycle projected through the public
  // API (list, issue, rotate/revoke confirmations, connections). The
  // console holds zero credential state; the safe-rules and env-contract
  // sections stay the authority's own vocabulary.
  const sections = await credentialsSections(credentials, {}, ctx.query);
  const content = `${pageHead({ title: "API keys & credentials", path: "/console/applications/keys" })}
${applicationsTabNav("keys")}
<h2>The console's transport credential</h2>
<p>The console authenticates to the governed API with a transport credential bound from the environment at startup${scope.length > 0 ? `, inside application scope <span class="mono">${esc(scope)}</span>` : ""}. It crosses the wire only as the Authorization bearer header, and it is never rendered on any page, never logged, and never stored in a cookie — no wire shape the console renders even has a field where it could appear. The SDK surface is secret-safe by construction: credentials are references, never values.</p>
<h2>Safe credential rules</h2>
${distinctionList([
  {
    label: "Bring-your-own keys stay server-side",
    fact: "Provider credentials are BYOK references handled by the platform; the public SDK types carry no secret material.",
    backed: true,
  },
  {
    label: "Shown at most once, where policy requires",
    fact: "Where the platform's issuance policy displays a secret, it is shown exactly once at creation — never retrievable afterwards.",
    backed: true,
  },
  {
    label: "Never logged, never echoed",
    fact: "Secret-shaped values are redacted defensively before any console rendering ([not displayed]) — the hostile-value probes pin it.",
    backed: true,
  },
  {
    label: "Credential lifecycle in this console",
    fact: "Live: the credential authority's lifecycle (issue with show-once, metadata-only list, rotate, revoke) projects through the public API onto this page — the console composes it, never re-implements it.",
    backed: true,
  },
])}
<h2>The environment contract (names only — never values)</h2>
${keyValueTable([
  ["ZECK_API_URL", "the governed API base URL the console and SDK talk to"],
  ["ZECK_TOKEN", "the Zeck transport credential (never a provider key)"],
  ["ZECK_APPLICATION_ID", "the application scope this console is bound to"],
  ["ZECK_ENVIRONMENT_ID", "optional — a disposable sandbox environment for executions"],
])}
${sections}
<p>Guided path: <a href="/console/docs/AUTH.md">authentication</a> and <a href="/console/docs/CONFIGURATION.md">provider/model configuration</a> in the docs. Routing facts from real runs (BYOK, secret-mediated): <a href="/assets/connections">Connections</a>.</p>`;
  return page(
    {
      title: "Zeck — API keys & credentials",
      activePath: "/console/applications/keys",
      mainContent: content,
    },
    ctx,
  );
}

/**
 * The issue POST (DEP-011): the governed mutation through the credential
 * transport. The FIRST response IS the show-once reveal (no server-side
 * state — M24); a re-POST of the same idempotency key renders the honest
 * replay page (the authority returns no secret on replay).
 */
async function credentialIssueHandler(
  credentials: CredentialConsoleTransport | null,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  void scope;
  if (credentials === null) {
    return page(
      {
        title: "Zeck — Credential action unavailable",
        activePath: "/console/applications/keys",
        mainContent: credentialMutationUnavailableContent("issue"),
      },
      ctx,
    );
  }
  const validation = validateCredentialIssueForm(ctx.form);
  if (validation.values === null) {
    const sections = await credentialsSections(
      credentials,
      ctx.form,
      new URLSearchParams(),
      validation.errors,
    );
    const content = `${pageHead({ title: "API keys & credentials", path: "/console/applications/keys" })}
${applicationsTabNav("keys")}
<div id="form-status" role="status" aria-live="polite" class="live-region">The credential could not be issued — fix the highlighted fields.</div>
${sections}`;
    return htmlStatusResult(
      422,
      appShell({
        title: "Zeck — API keys & credentials",
        activePath: "/console/applications/keys",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  try {
    const view = await credentials.issueCredential(
      { label: validation.values.label, role: validation.values.role },
      validation.values.idempotencyKey,
    );
    const content =
      view.replayed || view.secret === null
        ? credentialReplayContent({ action: "issued", view })
        : credentialRevealContent({ action: "issued", view });
    return page(
      {
        title: "Zeck — Credential issued",
        activePath: "/console/applications/keys",
        mainContent: content,
      },
      ctx,
    );
  } catch (error) {
    if (error instanceof ZeckApiError && error.status < 500) {
      const sections = await credentialsSections(credentials, ctx.form, new URLSearchParams());
      const content = `${pageHead({ title: "API keys & credentials", path: "/console/applications/keys" })}
${applicationsTabNav("keys")}
<div id="form-status" role="status" aria-live="polite" class="live-region">The platform rejected this issuance: ${esc(
        error.body.message,
      )} (${esc(error.body.code)})</div>
${sections}`;
      return htmlStatusResult(
        error.status === 403 || error.status === 401 ? 403 : 422,
        appShell({
          title: "Zeck — API keys & credentials",
          activePath: "/console/applications/keys",
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

/** The rotate POST: successor secret (show-once reveal / honest replay). */
async function credentialRotateHandler(
  credentials: CredentialConsoleTransport | null,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  void scope;
  if (credentials === null) {
    return page(
      {
        title: "Zeck — Credential action unavailable",
        activePath: "/console/applications/keys",
        mainContent: credentialMutationUnavailableContent("rotate"),
      },
      ctx,
    );
  }
  const credentialId = ctx.params.credentialId ?? "";
  const idempotencyKey = (ctx.form.idempotencyKey ?? "").trim();
  if (idempotencyKey.length === 0) {
    return redirectResult("/console/applications/keys");
  }
  try {
    const view = await credentials.rotateCredential(credentialId, idempotencyKey);
    const content =
      view.replayed || view.secret === null
        ? credentialReplayContent({ action: "rotated", view })
        : credentialRevealContent({ action: "rotated", view });
    return page(
      {
        title: "Zeck — Credential rotated",
        activePath: "/console/applications/keys",
        mainContent: content,
      },
      ctx,
    );
  } catch (error) {
    if (error instanceof ZeckApiError && error.status < 500) {
      const sections = await credentialsSections(credentials, {}, new URLSearchParams());
      const content = `${pageHead({ title: "API keys & credentials", path: "/console/applications/keys" })}
${applicationsTabNav("keys")}
<div id="form-status" role="status" aria-live="polite" class="live-region">The platform rejected this rotation: ${esc(
        error.body.message,
      )} (${esc(error.body.code)})</div>
${sections}`;
      return htmlStatusResult(
        error.status === 401 || error.status === 403 ? 403 : 422,
        appShell({
          title: "Zeck — API keys & credentials",
          activePath: "/console/applications/keys",
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

/** The revoke POST: immediate + idempotent; PRG back to the list. */
async function credentialRevokeHandler(
  credentials: CredentialConsoleTransport | null,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  void scope;
  if (credentials === null) {
    return page(
      {
        title: "Zeck — Credential action unavailable",
        activePath: "/console/applications/keys",
        mainContent: credentialMutationUnavailableContent("revoke"),
      },
      ctx,
    );
  }
  const credentialId = ctx.params.credentialId ?? "";
  const idempotencyKey = (ctx.form.idempotencyKey ?? "").trim();
  if (idempotencyKey.length === 0) {
    return redirectResult("/console/applications/keys");
  }
  try {
    await credentials.revokeCredential(credentialId, idempotencyKey);
    // PRG: the list renders the authority's own status transition.
    return redirectResult("/console/applications/keys");
  } catch (error) {
    if (error instanceof ZeckApiError && error.status < 500) {
      const sections = await credentialsSections(credentials, {}, new URLSearchParams());
      const content = `${pageHead({ title: "API keys & credentials", path: "/console/applications/keys" })}
${applicationsTabNav("keys")}
<div id="form-status" role="status" aria-live="polite" class="live-region">The platform rejected this revocation: ${esc(
        error.body.message,
      )} (${esc(error.body.code)})</div>
${sections}`;
      return htmlStatusResult(
        error.status === 401 || error.status === 403 ? 403 : 422,
        appShell({
          title: "Zeck — API keys & credentials",
          activePath: "/console/applications/keys",
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

async function environmentsConsolePage(
  client: ZeckClient,
  ctx: HttpContext,
  sandboxGovernance: SandboxGovernanceTransport | null,
): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const governance = await sandboxGovernanceSections(sandboxGovernance, ctx);
  const content = `${pageHead({ title: "Environments", path: "/console/applications/environments" })}
${applicationsTabNav("environments")}
<p>Environments recorded on executions this browser opened — the developer view of where sandbox runs execute. A disposable sandbox environment id (ZECK_ENVIRONMENT_ID, optional) can be attached per run; the playground's run form carries the same field.</p>
${environmentsSection(environmentFacts(recents.executions))}
${governance}
${unavailableState(
  "Environment inventory and provisioning",
  "There is no environment inventory or provisioning route in the public API — environment facts here are derived live from real runs, and the compute authority owns environment lifecycle.",
  "the compute authority through the public API",
)}
<p>The operator's environment surface: <a href="/admin/environments">Environments (Control)</a>.</p>`;
  return page(
    {
      title: "Zeck — Environments",
      activePath: "/console/applications/environments",
      mainContent: content,
    },
    ctx,
    { setCookies },
  );
}

/** The DEP-014 governance sections: quotas, identities, policy. */
async function sandboxGovernanceSections(
  transport: SandboxGovernanceTransport | null,
  ctx: HttpContext,
): Promise<string> {
  if (transport === null) {
    return unavailableState(
      "Sandbox budgets, quotas and the data policy",
      "The sandbox governance transport is not bound in this deployment (ZECK_API_URL / ZECK_TOKEN) — the quotas, expiration/reset and synthetic-data-policy surfaces render when the composition wires them. Nothing is fabricated in their place.",
      "GET /sandbox/quotas, GET /sandbox/identities/:id, POST /sandbox/identities/:id/reset, GET /sandbox/data-policy",
    );
  }
  let quotas: readonly SandboxQuotaFact[] = [];
  let telemetryRealtime = false;
  let policy: SyntheticDataPolicyFact | null = null;
  try {
    const quotaList = await transport.listQuotas("");
    quotas = quotaList.quotas;
    telemetryRealtime = quotaList.telemetry.realtime;
  } catch {
    quotas = [];
  }
  try {
    policy = await transport.dataPolicy();
  } catch {
    policy = null;
  }
  const quotaRows =
    quotas.length === 0
      ? emptyState(
          "No quotas configured",
          "No sandbox quota records are visible to this scope — quotas appear here when the application configures them (per dimension: spend, wall-clock time, concurrent runs, artifact count/bytes).",
        )
      : `<table class="data">
  <thead><tr><th scope="col">Dimension</th><th scope="col">Consumed</th><th scope="col">Limit</th><th scope="col">Window</th><th scope="col">Status</th><th scope="col">Use</th></tr></thead>
  <tbody>${quotas
    .map(
      (quota) => `<tr>
      <td>${esc(quotaDimensionLabel(quota.dimension))}</td>
      <td class="mono">${esc(quota.consumed)}</td>
      <td class="mono">${esc(quota.limit)}</td>
      <td>${esc(quota.window)}</td>
      <td>${esc(quota.status)}</td>
      <td>${quotaProgressOf(quota)}%</td>
    </tr>`,
    )
    .join("\n  ")}</tbody>
</table>`;
  const policyBlock =
    policy === null
      ? unavailableState(
          "The synthetic-data policy",
          "The policy route answered with an error — the versioned policy document renders here when the composition serves it.",
          "GET /sandbox/data-policy",
        )
      : `<h3>Synthetic-data policy (version ${esc(policy.version)})</h3>
<p class="mono">${esc(policy.digest)}</p>
<p><strong>Permitted in sandboxes:</strong> ${policy.permittedClasses.map((c) => esc(c)).join(", ")}</p>
<p><strong>Prohibited (fail-closed):</strong> ${policy.prohibitedClasses.map((c) => esc(c)).join(", ")}</p>
<ul>${policy.enforcement.map((e) => `<li><strong>${esc(e.point)}:</strong> ${esc(e.behavior)}</li>`).join("")}</ul>
<p class="muted">${esc(policy.violationRecording)}</p>`;
  const resetHint =
    ctx.query.get("reset") === "done"
      ? '<p class="state-source" role="status">The sandbox identity was reset — a fresh successor identity was established; nothing carried forward.</p>'
      : "";
  return `<h2>Sandbox budgets and quotas</h2>
${quotaRows}
${
  telemetryRealtime
    ? ""
    : unavailableState(
        "Real-time consumption telemetry",
        "Quota consumption updates on read — the public API exposes no real-time consumption stream.",
        "a consumption-telemetry projection over GET /sandbox/quotas",
      )
}
${resetHint}
<h2>Synthetic-data policy</h2>
${policyBlock}
<p class="muted">Identity expiration and reset: a disposable sandbox identity carries a TTL; after expiry (or quota exhaustion) the reset operation establishes a fresh successor — idempotent, confirmable, and carrying nothing forward. Identity lifecycle facts render on the identity routes (GET /sandbox/identities/:id, POST /sandbox/identities/:id/reset).</p>`;
}

async function usagePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const results = await Promise.all(
    recents.executions.map(async (execution) => {
      try {
        return await client.getResult(execution.id);
      } catch (error) {
        if (error instanceof ZeckApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    }),
  );
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const rows =
    recents.executions.length === 0
      ? emptyState(
          "No usage yet",
          "No executions have been opened in this browser — per-run usage appears here as runs are opened. The public API exposes no aggregate usage route.",
        )
      : `<table class="data">
  <thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Input tokens</th><th scope="col">Output tokens</th><th scope="col">Settled cost</th></tr></thead>
  <tbody>${recents.executions
    .map((execution, index) => {
      const result = results[index] ?? null;
      const usage = result?.usage ?? null;
      const cost = result?.cost ?? null;
      return `<tr>
      <td><a href="/runs/${encodeURIComponent(execution.id)}">${esc(
        executionTitle(execution.task, execution.id),
      )}</a></td>
      <td>${statusBadge(execution.status)}</td>
      <td>${usage === null ? '<span class="muted">not recorded</span>' : esc(usage.inputTokens)}</td>
      <td>${usage === null ? '<span class="muted">not recorded</span>' : esc(usage.outputTokens)}</td>
      <td>${
        cost === null
          ? '<span class="muted">not settled yet</span>'
          : esc(formatMicroUsd(cost.totalMicroUsd))
      }</td>
    </tr>`;
    })
    .join("")}</tbody>
</table>`;
  const content = `${pageHead({ title: "Usage", path: "/console/applications/usage" })}
${applicationsTabNav("usage")}
<p>Per-run usage for executions opened in this browser — provider-reported token usage and settled cost as the public result package records them (${esc(RECENTS_NOTE)}).</p>
${rows}
${unavailableState(
  "Aggregate usage and billing",
  "There is no aggregate usage or billing route in the public API — usage facts are per execution, projected live from the runs this browser opened. When an aggregate surface ships, its facts will come from the economics authorities through the public API.",
  "the economics authorities through the public API",
)}
<p>Per-run spend, limits and categories: <a href="/admin/budgets">Spend (Control)</a>.</p>`;
  return page(
    { title: "Zeck — Usage", activePath: "/console/applications/usage", mainContent: content },
    ctx,
    { setCookies },
  );
}

// ---------------------------------------------------------------------------
// Playground (DEP-010 — every workload family, honest availability;
// DEP-013 — the INTERACTIVE playground: choose → compose → run → inspect)
// ---------------------------------------------------------------------------

/** The catalog rows: every family the machine capability manifest records. */
function playgroundFamilyRows(): string {
  return `<table class="data">
  <thead><tr><th scope="col">Family</th><th scope="col">Classification</th><th scope="col">Recorded availability</th><th scope="col">Corpus tasks</th><th scope="col">Example</th></tr></thead>
  <tbody>${consoleFamilies()
    .map(
      (family) => `<tr>
      <td><a href="/console/playground/${encodeURIComponent(family.family)}">${esc(
        family.family,
      )}</a></td>
      <td>${classificationChip(family.classification)}</td>
      <td>${esc(family.availability)}</td>
      <td>${String(corpusTaskCountOf(family.family))}</td>
      <td class="mono"><a href="/console/playground/${encodeURIComponent(
        family.family,
      )}/example">${esc(family.example)}</a></td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
}

async function playgroundPage(ctx: HttpContext): Promise<HandlerResult> {
  const split = familiesByClassification();
  const content = `${pageHead({
    title: "Playground",
    path: "/console/playground",
    primaryActionHtml:
      '<a class="button-link primary" href="/console/playground/text">Compose a text run</a>',
  })}
<p>Choose any workload class the platform supports, compose your own run over the class's advertised contract, execute it in the governed sandbox and inspect the outcome end to end — editable parameters, not canned demos. The catalog below is projected live from the machine capability manifest (the same source the validation program validates), so the console can never drift from it.</p>
<ol class="steps">
  <li><strong>Choose</strong> a workload class — every family the catalog carries, rendered from the manifest (never hardcoded).</li>
  <li><strong>Compose</strong> the run — editable inputs constrained to the recorded synthetic corpus vocabulary and envelopes.</li>
  <li><strong>Run</strong> it — a real execution through the governed public API under a disposable-sandbox identity.</li>
  <li><strong>Inspect</strong> it — the outcome deep-links into the execution explorer's public facts (result, verification, events, costs where exposed).</li>
</ol>
<h2>Families</h2>
${playgroundFamilyRows()}
<p class="muted">${split.runnable.length} families classify runnable (the integration path is live for any deployment exposing the public API); ${split.providerGated.length} classify provider-gated (completion requires provider capabilities that may be gated or absent — the gate is about the deployment's rails, never about your code). Families whose required capability has no candidate provider rail render an honest NOT RUN state on their page — never hidden, never faked.</p>
${sandboxLimitsSection()}`;
  return page(
    { title: "Zeck — Playground", activePath: "/console/playground", mainContent: content },
    ctx,
  );
}

/** The required-access table + the honest NOT RUN boundaries (DEP-013 AC3). */
function playgroundAccessSection(family: ConsoleFamily): string {
  const availability = playgroundAvailabilityOf(family);
  const rows = `<table class="data">
  <thead><tr><th scope="col">Required capability</th><th scope="col">Kind</th><th scope="col">Access requirement</th><th scope="col">Candidate credentials (names)</th><th scope="col">In this deployment</th></tr></thead>
  <tbody>${availability.facts
    .map(
      (fact) => `<tr>
      <td class="mono">${esc(fact.capability)}</td>
      <td>${esc(fact.kind)}</td>
      <td>${esc(fact.accessRequirement)}</td>
      <td>${
        fact.kind !== "provider-rail" || fact.candidateEnvVars.length === 0
          ? '<span class="muted">—</span>'
          : fact.candidateEnvVars.map((name) => `<span class="mono">${esc(name)}</span>`).join(", ")
      }</td>
      <td>${
        fact.kind !== "provider-rail"
          ? "—"
          : fact.candidateEnvVars.length === 0
            ? "no candidate provider recorded"
            : fact.candidateEnvVars
                .map((name) =>
                  availability.presentEnvVars.includes(name)
                    ? `<span class="mono">${esc(name)}</span> present`
                    : `<span class="mono">${esc(name)}</span> absent`,
                )
                .join("; ")
      }</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
  const blocked =
    availability.hardBlocked.length === 0
      ? ""
      : `\n${availability.hardBlocked
          .map(
            (block) => `<div class="state state-blocked">
  <p class="state-title">NOT RUN — ${esc(block.capability)} has no provider in the authorized set</p>
  <p class="state-body">${esc(block.reason)} ${esc(block.accessRequirement)}</p>
  <p class="state-source">Recorded by the capability matrix and the machine capability manifest — never converted into a pass; the Lead owns the credentialed re-run.</p>
</div>`,
          )
          .join("\n")}`;
  const missing =
    availability.missingEnvVars.length === 0
      ? ""
      : `<p class="muted">Absent in this deployment's environment: ${availability.missingEnvVars
          .map((name) => `<span class="mono">${esc(name)}</span>`)
          .join(
            ", ",
          )} (names only — values are never read, never rendered). A composed run still submits through the governed API with synthetic data; the platform's authorized rails and policy admission decide the outcome, and a missing-rail outcome is recorded as it occurs — never represented as PASS.</p>`;
  return `<section class="card">
  <h2>Required access</h2>
  ${rows}
  ${blocked}
  ${missing}
</section>`;
}

/** The honest NOT RUN gate that replaces the commit path for hard-blocked families. */
function playgroundNotRunState(family: ConsoleFamily): string {
  const availability = playgroundAvailabilityOf(family);
  const naming = availability.hardBlocked
    .map((block) => `${block.capability} (${block.accessRequirement})`)
    .join("; ");
  return `<div class="state state-blocked">
  <p class="state-title">Interactive run — NOT RUN for the ${esc(family.family)} family</p>
  <p class="state-body">This family's completion requires a capability the authorized provider set does not carry: ${esc(
    naming,
  )}. The console refuses to submit a run it cannot honestly pursue — the class stays visible and compose-able, the recorded availability stays verbatim below, and the missing contract is named, never faked.</p>
  <p class="state-source">Reproduce the integration shape without the console: the copyable example <a href="/console/playground/${encodeURIComponent(
    family.family,
  )}/example">${esc(family.example)}</a>; live-rail rows are the Lead's credentialed environment.</p>
</div>`;
}

/** The honest unavailable state for parameterizable environment templates. */
function playgroundEnvironmentNote(): string {
  return unavailableState(
    "Parameterizable sandbox environment templates",
    "The composer carries the optional environment id passthrough (the create contract's environmentId selector) and the sandbox envelope's budget, latency and concurrency ceilings. Environment TEMPLATES a developer may parameterize are not yet exposed by the public API — no console-local shape can honestly stand in for them.",
    "the sandbox environments surface (the environments authority's public contract; the budgets/quotas/expiration program is DEP-014)",
  );
}

/** The synthetic-data discipline note (what is enforced, what is DEP-014's). */
function playgroundSyntheticDataNote(): string {
  return `<p class="muted">Synthetic-data-only enforcement is active in this composer: fixture fields accept only the family's recorded synthetic corpus values, numeric parameters sit inside the recorded envelopes, and free text is neutralized (real-world web addresses, emails, IPs, long digit runs, credential-shaped material, markup, control characters and opaque blobs are refused before any wire call). The platform-wide synthetic-data policy surface is owned by DEP-014 (not yet merged at this revision) — until it lands, this composer's rules are the enforced boundary.</p>`;
}

/** One composer field's input (the interactive editable control). */
function composerFieldHtml(
  field: ComposerField,
  values: Record<string, string>,
  errors: Record<string, string | undefined>,
): string {
  const id = `pf-task-${field.key}`;
  const formKey = formKeyOf(field);
  const raw = values[formKey] ?? "";
  const error = errors[formKey];
  switch (field.kind) {
    case "fixed":
      return `<div class="form-field">
  <p class="form-label"><span class="mono">${esc(formKey)}</span> — fixed by the advertised contract</p>
  <p class="form-value mono">${esc(field.value)}</p>
  <p class="form-hint">The task discriminator is part of the class's recorded shape; the composer never lets the wire payload change it.</p>
</div>`;
    case "select":
      return executionFormField(
        id,
        formKey,
        `<select id="${id}" name="${esc(formKey)}">${field.values
          .map(
            (value) =>
              `<option value="${esc(value)}"${(raw.length > 0 ? raw : field.defaultValue) === value ? " selected" : ""}>${esc(value)}</option>`,
          )
          .join("")}</select>`,
        "One of the family's recorded synthetic corpus values (synthetic-data-only enforcement — free entry is not accepted).",
        error,
      );
    case "number":
      return executionFormField(
        id,
        formKey,
        `<input id="${id}" name="${esc(formKey)}" value="${esc(
          raw.length > 0 ? raw : String(field.defaultValue),
        )}" inputmode="numeric" type="number" min="${String(field.min)}" max="${String(
          field.max,
        )}" step="1">`,
        `A whole number within the recorded envelope for this family: ${String(
          field.min,
        )}–${String(field.max)}.`,
        error,
      );
    case "boolean":
      return executionFormField(
        id,
        formKey,
        `<select id="${id}" name="${esc(formKey)}">${["true", "false"]
          .map(
            (value) =>
              `<option value="${value}"${(raw.length > 0 ? raw : String(field.defaultValue)) === value ? " selected" : ""}>${value}</option>`,
          )
          .join("")}</select>`,
        "The recorded contract's flag (true or false).",
        error,
      );
    case "list":
      return executionFormField(
        id,
        formKey,
        `<input id="${id}" name="${esc(formKey)}" value="${esc(
          raw.length > 0 ? raw : field.defaultValue.join(","),
        )}" placeholder="${esc(field.defaultValue.join(","))}">`,
        `Comma-separated items from the recorded synthetic vocabulary: ${field.vocabulary.join(
          ", ",
        )}.`,
        error,
      );
    case "text":
      return executionFormField(
        id,
        formKey,
        `<input id="${id}" name="${esc(formKey)}" value="${esc(
          raw.length > 0 ? raw : field.defaultValue,
        )}" maxlength="${String(field.maxLength)}">`,
        `Free synthetic text (at most ${String(
          field.maxLength,
        )} characters). Real-world identifiers, credential-shaped material, markup and opaque blobs are refused — the synthetic-data-only rule.`,
        error,
      );
  }
}

/** The interactive composer form (choose → compose; GET round-trips the composed values). */
function playgroundComposerForm(
  family: ConsoleFamily,
  values: Record<string, string>,
  errors: Record<string, string | undefined>,
  idempotencyKey: string,
): string {
  const taskFields = composerSchemaOf(family)
    .map((field) => composerFieldHtml(field, values, errors))
    .join("\n");
  return `<form class="flow card" method="get" action="/console/playground/${encodeURIComponent(
    family.family,
  )}">
  <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
  ${executionFormField(
    "pf-application",
    "Application id",
    `<input id="pf-application" name="applicationId" value="${esc(
      values.applicationId ?? "",
    )}" required>`,
    "The governed application scope the sandbox execution (and any spend) belongs to.",
    errors.applicationId,
  )}
  ${executionFormField(
    "pf-environment",
    "Compute environment (optional)",
    `<input id="pf-environment" name="environmentId" value="${esc(values.environmentId ?? "")}">`,
    "Leave empty for the default environment; a disposable sandbox environment id goes here.",
    errors.environmentId,
  )}
  ${executionFormField(
    "pf-spend",
    `Spend limit (dollars, optional — sandbox ceiling $${PLAYGROUND_BUDGET_LIMIT_DOLLARS})`,
    `<input id="pf-spend" name="spendLimitDollars" value="${esc(
      values.spendLimitDollars ?? "",
    )}" inputmode="decimal" placeholder="1.50">`,
    `Sent as the per-run cost constraint. The $${PLAYGROUND_BUDGET_LIMIT_DOLLARS} ceiling is enforced either way; a higher entry is refused before any wire call.`,
    errors.spendLimitDollars,
  )}
  <h3>The composed task (the class's advertised contract)</h3>
  <p class="muted">Every field below is derived from the family's recorded task shape with the synthetic corpus as the value authority — the composed payload can only carry synthetic data.</p>
  ${taskFields}
  <div class="form-actions"><button type="submit" class="primary">Review the sandbox run</button></div>
</form>
${playgroundSyntheticDataNote()}
${playgroundEnvironmentNote()}`;
}

function playgroundEditLink(
  family: ConsoleFamily,
  values: Record<string, string>,
  idempotencyKey: string,
): string {
  const params = new URLSearchParams();
  for (const key of interactiveFormKeysOf(family)) {
    params.set(key, values[key] ?? "");
  }
  params.set("edit", "1");
  params.set("idempotencyKey", idempotencyKey);
  return `/console/playground/${encodeURIComponent(family.family)}?${params.toString()}`;
}

/** The proposed-run envelope: exactly what the create request will carry. */
function playgroundEnvelope(family: ConsoleFamily, request: ExecutionRequest): string {
  const constraints = request.constraints ?? {};
  const budget =
    constraints.maxCostMicroUsd === undefined
      ? `$${PLAYGROUND_BUDGET_LIMIT_DOLLARS}`
      : formatMicroUsd(constraints.maxCostMicroUsd);
  const latencySeconds = Math.round(
    (constraints.maxLatencyMs ?? PLAYGROUND_LATENCY_LIMIT_MS) / 1000,
  );
  return `<div class="card review-envelope">
  <h2>Proposed sandbox run</h2>
  <h3>The composed task (your edited parameters)</h3>
  ${keyValueTable(safeTaskPairs(request.task))}
  <h3>Capability requirements</h3>
  <ul>${family.capabilityRequirements
    .map((requirement) => `<li class="mono">${esc(requirement)}</li>`)
    .join("")}</ul>
  <h3>Sandbox constraints</h3>
  ${keyValueTable([
    ["Cost ceiling", budget],
    ["Latency ceiling", `${latencySeconds} seconds`],
    ["Sandbox identity", `${PLAYGROUND_ORIGIN} (disposable, interactive)`],
    ["Example", family.example],
  ])}
  <p class="muted">No provider, model, rail, connection or agent is selected — the frozen create contract forbids provider selection, and Zeck owns the route. Policy admission is decided platform-side at dispatch.</p>
</div>`;
}

/** The consequence/commitment card for an interactive run (the WORK-035 confirmation primitive). */
function playgroundCommitmentCard(
  family: ConsoleFamily,
  values: Record<string, string>,
  request: ExecutionRequest,
  idempotencyKey: string,
  confirmLabel: string,
): string {
  const constraints = request.constraints ?? {};
  const budget =
    constraints.maxCostMicroUsd === undefined
      ? PLAYGROUND_BUDGET_LIMIT_DOLLARS
      : formatMicroUsd(constraints.maxCostMicroUsd);
  const latencySeconds = Math.round(
    (constraints.maxLatencyMs ?? PLAYGROUND_LATENCY_LIMIT_MS) / 1000,
  );
  return confirmationCard({
    title: "Run this sandbox execution?",
    consequence: `Run submits the governed create request for your COMPOSED ${family.family} task: exactly one execution is created, Zeck plans the route and executes under policy, and the events, verification results, output artifacts and settled cost are recorded platform-side — you follow the run on its execution page. The sandbox identity (${PLAYGROUND_ORIGIN}, disposable, interactive) rides the request's metadata.`,
    affected: `A governed execution record in application ${values.applicationId ?? ""}${
      (values.environmentId ?? "").length > 0
        ? `, environment ${values.environmentId ?? ""}`
        : " (default environment)"
    }.`,
    cost: `Spend ceiling ${budget} and latency ceiling ${latencySeconds} seconds — the request's own constraints. No pre-run estimate exists; the settled cost is recorded per execution on the run's header facts.`,
    whyAllowed:
      "The create request is valid against the frozen create contract — it selects no provider, model, rail, connection or agent (selection is forbidden; the platform plans the route), and policy admission is decided platform-side at dispatch: a denial is surfaced on the execution, never silently retried.",
    reversible: false,
    reversibleDetail:
      "No — a committed execution cannot be undone through the public contract. The governed stop is Cancel (its own consequence preview); work already performed and its evidence stay recorded and inspectable.",
    approvalNote:
      "No user pre-approval is part of the public create contract — the platform's policy admission at dispatch is the authorization boundary.",
    idempotencyNote: `The idempotency key ${idempotencyKey} is carried: resubmitting the same request converges on ONE execution rather than creating duplicates.`,
    hiddenFields: interactiveFormKeysOf(family)
      .filter((key) => key !== "idempotencyKey" || (values[key] ?? "").length > 0)
      .map((key) => [key, values[key] ?? ""] as const),
    confirmAction: `/console/playground/${encodeURIComponent(family.family)}`,
    confirmLabel,
    cancelHref: playgroundEditLink(family, values, idempotencyKey),
  });
}

function playgroundFamilyNotFoundView(familyId: string, ctx: HttpContext): HandlerResult {
  const content = `${pageHead({ title: "Workload family not found", path: "/console/playground" })}
${errorState(
  "No such workload family",
  `The machine capability manifest records no family "${familyId}" — the console projects the manifest and invents nothing.`,
  "docs/developer/machine/capability-manifest.json (the validated machine contract)",
)}
<p><a href="/console/playground">Back to the playground catalog</a></p>`;
  return htmlStatusResult(
    404,
    appShell({
      title: "Zeck — Workload family not found",
      activePath: "/console/playground",
      mainContent: content,
      appearance: appearanceOf(ctx.cookies),
      mode: modeOf(ctx.cookies),
      returnTo: ctx.path,
    }),
  );
}

function playgroundConcurrencyGate(inFlight: number): string {
  return `<div class="state state-blocked">
  <p class="state-title">Sandbox concurrency limit reached</p>
  <p class="state-body">${inFlight} sandbox runs opened in this browser are still in flight (the limit is ${PLAYGROUND_MAX_CONCURRENT_RUNS}). The console refuses to submit another until one finishes or is cancelled — uncontrolled spend and side effects are prevented by default, and this gate holds no server-side state: it is derived live from the runs this browser opened.</p>
  <p class="state-source">Open the active runs to wait or cancel: <a href="/runs/active">Active runs</a>.</p>
</div>`;
}

/** The run-history section: this browser's playground runs of the family (inspect deep links). */
function playgroundRunHistorySection(
  family: ConsoleFamily,
  runs: readonly PlaygroundRunFact[],
): string {
  void family;
  if (runs.length === 0) {
    return `<h2>Run history (this browser)</h2>
${emptyState(
  "No interactive runs of this family yet",
  "Runs you compose and execute in this browser appear here with deep links into the execution explorer's public facts — result, verification, events and costs where exposed.",
  RECENTS_NOTE,
)}`;
  }
  return `<h2>Run history (this browser)</h2>
<table class="data">
  <thead><tr><th scope="col">Execution</th><th scope="col">Composed</th><th scope="col">Status</th><th scope="col">Opened</th><th scope="col">Compare</th></tr></thead>
  <tbody>${runs
    .map(
      (run) => `<tr>
      <td><a href="/runs/${encodeURIComponent(run.executionId)}" class="mono">${esc(
        run.executionId,
      )}</a></td>
      <td>${run.composed ? "interactive" : "guided"}</td>
      <td>${statusBadge(run.status)}</td>
      <td>${esc(run.createdAt)}</td>
      <td><a href="${esc(compareLinkOf(run.executionId))}">Compare</a></td>
    </tr>`,
    )
    .join("")}</tbody>
</table>
<p class="muted">${esc(RECENTS_NOTE)} · <a href="/console/compare">Compare runs</a>: pick a second run of this family (the Compare column pins run a) and see both side by side — status, cost, route, verification, duration — with the platform's own recorded planning explanation for each route.</p>`;
}

async function playgroundFamilyPage(
  client: ZeckClient,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const familyId = ctx.params.family ?? "";
  const family = familyOf(familyId);
  if (family === null) {
    return playgroundFamilyNotFoundView(familyId, ctx);
  }
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const history = playgroundRunsForFamily(recents.executions, family.family);
  const inFlight = inFlightCount(recents.executions);
  const gated = inFlight >= PLAYGROUND_MAX_CONCURRENT_RUNS;
  const availability = playgroundAvailabilityOf(family);
  const hardBlocked = familyIsHardBlocked(availability);
  const defaults = defaultTaskFormValuesOf(family);
  const query: Record<string, string> = {};
  for (const key of [...interactiveFormKeysOf(family), "edit"]) {
    const value = ctx.query.get(key);
    if (value !== null) {
      query[key] = value;
    }
  }
  const idempotencyKey =
    (query.idempotencyKey ?? "").length > 0
      ? (query.idempotencyKey ?? "")
      : `dash-${crypto.randomUUID()}`;
  const submitted = (query.applicationId ?? "").trim().length > 0;
  const values: Record<string, string> = {
    applicationId: query.applicationId ?? scope,
    environmentId: query.environmentId ?? "",
    spendLimitDollars: query.spendLimitDollars ?? "",
    idempotencyKey,
    ...defaults,
    ...query,
  };
  const reviewable = submitted && query.edit !== "1";
  let runSurface: string;
  if (gated) {
    runSurface = playgroundConcurrencyGate(inFlight);
  } else if (!reviewable) {
    runSurface = playgroundComposerForm(family, values, {}, idempotencyKey);
  } else {
    const validation = validateInteractiveRunForm(family, query);
    if (validation.values === null) {
      runSurface = playgroundComposerForm(family, values, validation.errors, idempotencyKey);
    } else if (hardBlocked) {
      runSurface = `${playgroundNotRunState(family)}
${playgroundComposerForm(family, values, {}, idempotencyKey)}`;
    } else {
      const task = composedTaskOf(family, validation.values);
      const request = buildInteractiveRunRequest(family, task, validation.values.envelope);
      runSurface = `${playgroundEnvelope(family, request)}
${playgroundCommitmentCard(family, values, request, idempotencyKey, "Run sandbox execution")}`;
    }
  }
  const example = exampleOfFamily(family);
  const exampleSection =
    example === null
      ? errorState(
          "The machine example inventory does not carry this family's recorded example",
          `The capability manifest records ${family.example} for this family, but the examples manifest carries no such entry — the console renders the miss honestly instead of inventing a link.`,
          "docs/developer/machine/examples-manifest.json",
        )
      : `<h2>The example behind this family</h2>
${keyValueTable([
  ["Example", example.path],
  ["Title", example.title],
  ["Classification", example.classification],
  ["Env vars (names only)", example.envVars.join(", ")],
])}
<p>Open the copyable source: <a href="/console/playground/${encodeURIComponent(
          family.family,
        )}/example">${esc(example.path)}</a> — the same wire contract this composer rides, runnable without the console: <span class="mono">ZECK_API_URL=… ZECK_TOKEN=… ZECK_APPLICATION_ID=… bun run ${esc(
          example.path,
        )}</span>. An agent reproduces any playground run from it; there is no UI-only path to capability.</p>`;
  const content = `${pageHead({
    title: `Playground — ${family.family}`,
    path: "/console/playground",
    currentLabel: family.family,
    primaryActionHtml: '<a class="button-link" href="/console/playground">All families</a>',
  })}
${familyAvailabilitySection(family)}
${playgroundAccessSection(family)}
<h2>The advertised contract</h2>
<p class="muted">The recorded synthetic task shape — the manifest's verbatim default for this family; the composer below edits within it.</p>
${playgroundTaskTable(family)}
<h2>Compose your run</h2>
${
  hardBlocked
    ? playgroundNotRunState(family)
    : '<p class="muted">Edit the parameters within the recorded synthetic vocabulary and envelopes, then review the exact request before it is submitted through the governed public API.</p>'
}
${runSurface}
${sandboxLimitsSection()}
${playgroundRunHistorySection(family, history)}
${exampleSection}`;
  return page(
    {
      title: `Zeck — Playground ${family.family}`,
      activePath: "/console/playground",
      mainContent: content,
    },
    ctx,
    { setCookies },
  );
}

async function createPlaygroundRunHandler(
  client: ZeckClient,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const familyId = ctx.params.family ?? "";
  const family = familyOf(familyId);
  if (family === null) {
    return playgroundFamilyNotFoundView(familyId, ctx);
  }
  const idempotencyKey = (ctx.form.idempotencyKey ?? "").trim();
  const availability = playgroundAvailabilityOf(family);
  const hardBlocked = familyIsHardBlocked(availability);
  const validation = validateInteractiveRunForm(family, ctx.form);
  if (validation.values === null || idempotencyKey.length === 0) {
    const errors: Record<string, string | undefined> = {
      ...(validation.errors as Record<string, string | undefined>),
    };
    if (idempotencyKey.length === 0) {
      errors.applicationId =
        (errors.applicationId ?? "") +
        (errors.applicationId === undefined ? "" : " ") +
        "The form state was lost — fill the application id again and resubmit.";
    }
    const defaults = defaultTaskFormValuesOf(family);
    const content = `${pageHead({
      title: `Playground — ${family.family}`,
      path: "/console/playground",
      currentLabel: family.family,
    })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The sandbox run could not be submitted — fix the highlighted fields.</div>
${playgroundComposerForm(
  family,
  { ...defaults, ...ctx.form, applicationId: ctx.form.applicationId ?? scope },
  errors,
  idempotencyKey.length > 0 ? idempotencyKey : `dash-${crypto.randomUUID()}`,
)}
${sandboxLimitsSection()}`;
    return htmlStatusResult(
      422,
      appShell({
        title: `Zeck — Playground ${family.family}`,
        activePath: "/console/playground",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  if (hardBlocked) {
    const content = `${pageHead({
      title: `Playground — ${family.family}`,
      path: "/console/playground",
      currentLabel: family.family,
    })}
<div id="form-status" role="status" aria-live="polite" class="live-region">This family is an honest NOT RUN boundary — the submission was refused before any wire call.</div>
${playgroundNotRunState(family)}
${playgroundAccessSection(family)}
${sandboxLimitsSection()}`;
    return htmlStatusResult(
      422,
      appShell({
        title: `Zeck — Playground ${family.family}`,
        activePath: "/console/playground",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  const values = validation.values;
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const inFlight = inFlightCount(recents.executions);
  if (inFlight >= PLAYGROUND_MAX_CONCURRENT_RUNS) {
    const content = `${pageHead({
      title: `Playground — ${family.family}`,
      path: "/console/playground",
      currentLabel: family.family,
    })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The sandbox concurrency limit refused this submission.</div>
${playgroundConcurrencyGate(inFlight)}
${sandboxLimitsSection()}`;
    return htmlStatusResult(
      422,
      appShell({
        title: `Zeck — Playground ${family.family}`,
        activePath: "/console/playground",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  try {
    const task = composedTaskOf(family, values);
    const request = buildInteractiveRunRequest(family, task, values.envelope);
    const { receipt } = await client.createExecution(request, idempotencyKey);
    return redirectResult(`/runs/${encodeURIComponent(receipt.executionId)}`);
  } catch (error) {
    if (error instanceof ZeckApiError && error.status < 500) {
      const policyBoundary =
        error.body.code === "POLICY_DENIED" || error.body.code === "BUDGET_EXCEEDED"
          ? `\n${createBlockedExplanation(error.body.code, error.body.message)}`
          : "";
      const task = composedTaskOf(family, values);
      const request = buildInteractiveRunRequest(family, task, values.envelope);
      const content = `${pageHead({
        title: `Playground — ${family.family}`,
        path: "/console/playground",
        currentLabel: family.family,
      })}
<div id="form-status" role="status" aria-live="polite" class="live-region">The platform rejected this sandbox request: ${esc(
        error.body.message,
      )} (${esc(error.body.code)})</div>
${policyBoundary}
${playgroundEnvelope(family, request)}
${playgroundCommitmentCard(
  family,
  {
    ...defaultTaskFormValuesOf(family),
    applicationId: values.envelope.applicationId,
    environmentId: values.envelope.environmentId,
    spendLimitDollars: values.envelope.spendLimitDollars,
    idempotencyKey,
    ...values.task,
  },
  request,
  idempotencyKey,
  "Try again",
)}`;
      return htmlStatusResult(
        422,
        appShell({
          title: `Zeck — Playground ${family.family}`,
          activePath: "/console/playground",
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

/** The copyable integration-kit example page (machine parity — DEP-013 AC6). */
async function playgroundExamplePage(ctx: HttpContext): Promise<HandlerResult> {
  const familyId = ctx.params.family ?? "";
  const family = familyOf(familyId);
  if (family === null) {
    return playgroundFamilyNotFoundView(familyId, ctx);
  }
  const example = exampleOfFamily(family);
  if (example === null) {
    const content = `${pageHead({ title: `Example — ${family.family}`, path: "/console/playground" })}
${errorState(
  "The machine example inventory does not carry this family's recorded example",
  `The capability manifest records ${family.example} for this family, but the examples manifest carries no such entry — the console renders the miss honestly instead of inventing a link.`,
  "docs/developer/machine/examples-manifest.json",
)}
<p><a href="/console/playground/${encodeURIComponent(family.family)}">Back to the family</a></p>`;
    return htmlStatusResult(
      404,
      appShell({
        title: `Zeck — Example ${family.family}`,
        activePath: "/console/playground",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  const source = readPlaygroundExampleSource(family);
  if (source === null) {
    const content = `${pageHead({ title: `Example — ${family.family}`, path: "/console/playground" })}
${errorState(
  "The recorded example file is not present in this repository checkout",
  `The machine manifests record ${family.example}, but the file could not be read from the repository — the console renders the miss honestly.`,
  "docs/developer/machine/examples-manifest.json (the validated machine inventory)",
)}
<p><a href="/console/playground/${encodeURIComponent(family.family)}">Back to the family</a></p>`;
    return htmlStatusResult(
      404,
      appShell({
        title: `Zeck — Example ${family.family}`,
        activePath: "/console/playground",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  const content = `${pageHead({
    title: `Example — ${family.family}`,
    path: "/console/playground",
    currentLabel: family.family,
    primaryActionHtml: `<a class="button-link" href="/console/playground/${encodeURIComponent(
      family.family,
    )}">Back to the composer</a>`,
  })}
<section class="card">
  <h2>The copyable integration-kit example</h2>
  ${keyValueTable([
    ["Path", example.path],
    ["Title", example.title],
    ["Workload family", example.family],
    ["Classification", example.classification],
    ["Env vars (names only)", example.envVars.join(", ")],
  ])}
  <p class="muted">Served verbatim and read-only from the repository — the same wire contract the interactive composer rides. Run it without the console: <span class="mono">ZECK_API_URL=… ZECK_TOKEN=… ZECK_APPLICATION_ID=… bun run ${esc(
    example.path,
  )}</span>. Machine parity: an agent reproduces any playground run from this file; there is no UI-only path to capability.</p>
</section>
<h2>Source (verbatim)</h2>
<pre class="raw">${esc(source)}</pre>`;
  return page(
    {
      title: `Zeck — Example ${family.family}`,
      activePath: "/console/playground",
      mainContent: content,
    },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Validation Lab (DEP-025 — the validation library and rerunnable
// experiment center; every definition is projected from repository truth)
// ---------------------------------------------------------------------------

/** The Validation Lab IA tab nav (the roadmap-governed section list). */
function validationTabNav(active: string): string {
  const tab = (name: string, label: string, href: string): string =>
    `<a href="${esc(href)}"${active === name ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<nav class="tabs" aria-label="Validation Lab views">
  ${tab("all", "All experiments", "/console/validation")}
  ${tab("capability", "By capability", "/console/validation/capability")}
  ${tab("workload", "By workload", "/console/validation/workload")}
  ${tab("stage", "By validation stage", "/console/validation/stage")}
  ${tab("start", "Recommended starting points", "/console/validation/start")}
  ${tab("agent", "Agent / machine interface", "/console/validation/agent")}
</nav>`;
}

/** The availability chip for an experiment row (symbol + text, never color alone). */
function validationRerunChip(experiment: ValidationExperiment): string {
  if (!experimentIsRerunnable(experiment)) {
    return '<span class="chip">⊘ suite reproduction</span>';
  }
  const blocked = availabilityOf(experiment).hardBlocked.length > 0;
  if (blocked) {
    return '<span class="chip">⊘ provider gap</span>';
  }
  return '<span class="chip">▶ rerunnable</span>';
}

function validationExperimentRows(experiments: readonly ValidationExperiment[]): string {
  return `<table class="data">
  <thead><tr><th scope="col">Experiment</th><th scope="col">Stage</th><th scope="col">Workload families</th><th scope="col">Console rerun</th><th scope="col">Recorded status</th></tr></thead>
  <tbody>${experiments
    .map(
      (experiment) => `<tr>
      <td><a href="/console/validation/${encodeURIComponent(experiment.id)}">${esc(
        experiment.id,
      )}</a><br><span class="muted">${esc(experiment.title)}</span></td>
      <td>${esc(experiment.stage)}</td>
      <td>${
        experiment.families.length === 0
          ? '<span class="muted">app-local corpus</span>'
          : experiment.families
              .map((family) => `<span class="mono">${esc(family)}</span>`)
              .join(", ")
      }</td>
      <td>${validationRerunChip(experiment)}</td>
      <td>${esc(experiment.status)}${
        experiment.recordedCoverage.length === 0
          ? ""
          : `<br><span class="muted">${esc(experiment.recordedCoverage[0]?.status ?? "")}</span>`
      }</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
}

function validationProgramFacts(): string {
  const experiments = validationExperiments();
  const rerunnable = experiments.filter((experiment) => experimentIsRerunnable(experiment));
  return keyValueTable([
    [
      "Experiments",
      `${String(experiments.length)} (every governed work order of the executed program)`,
    ],
    [
      "Console-rerunnable",
      `${String(rerunnable.length)} (a corpus task can be replayed through the governed API)`,
    ],
    [
      "Suite reproduction",
      `${String(experiments.length - rerunnable.length)} (the repository's governed suites are the reproduction path)`,
    ],
    ["Corpus version", "val-corpus.1.0.0 (the append-only golden corpus)"],
    ["Program status", "roadmap-complete (spec/validation-state/program-state.json)"],
    [
      "Un-issued ids",
      `${unissuedValidationIds().join(", ")} — never dispatched by the program; no definition exists`,
    ],
  ]);
}

function validationBoundaryInventory(): string {
  return advancedDisclosure(
    `The recorded NOT RUN boundaries (${String(notRunBoundaries().length)} — verbatim from the validation report)`,
    `<table class="data">
  <thead><tr><th scope="col">Surface</th><th scope="col">Exact reason</th></tr></thead>
  <tbody>${notRunBoundaries()
    .map(
      (boundary) => `<tr>
      <td>${esc(boundary.surface)}</td>
      <td>${esc(boundary.exactReason)}</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>
<p class="muted">A NOT RUN boundary never converts into a pass — the console projects the recorded reasons verbatim and never invents an availability fact.</p>`,
  );
}

function validationProviderTable(): string {
  return advancedDisclosure(
    "The recorded provider/model coverage (verbatim from the validation report)",
    `<table class="data">
  <thead><tr><th scope="col">Provider / model</th><th scope="col">Capability</th><th scope="col">Access status</th></tr></thead>
  <tbody>${providerCoverageRows()
    .map(
      (row) => `<tr>
      <td>${esc(row.providerModel)}</td>
      <td>${esc(row.capability)}</td>
      <td>${esc(row.accessStatus)}</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`,
  );
}

// ---------------------------------------------------------------------------
// Executions explorer (DEP-012 — the complete execution inspection surface
// over the public contracts: list → six-view detail → machine facts)
// ---------------------------------------------------------------------------

/** Live results fan-out for the list rows (a missing result is an honest
 * empty cost cell, never an error — the record may not be settled yet). */
async function readResults(
  client: ZeckClient,
  executionIds: readonly string[],
): Promise<Map<string, ExecutionResult>> {
  const reads = await Promise.all(
    executionIds.map(async (id) => {
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
  const results = new Map<string, ExecutionResult>();
  executionIds.forEach((id, index) => {
    const result = reads[index];
    if (result !== null && result !== undefined) {
      results.set(id, result);
    }
  });
  return results;
}

function explorerListRows(runs: readonly ExplorerRunFact[]): string {
  if (runs.length === 0) {
    return emptyState(
      "No executions opened in this browser yet",
      "Run one from the playground, the validation lab, or the quickstart — executions you open appear here for inspection.",
    );
  }
  const rows = runs
    .map(
      (run) => `<tr>
      <td><a class="run-title" href="/console/executions/${encodeURIComponent(run.id)}">${esc(run.id)}</a></td>
      <td>${statusBadge(run.status)}</td>
      <td>${esc(run.family)}</td>
      <td class="mono">${esc(run.createdAt)}</td>
      <td class="mono">${run.terminalAt === null ? "—" : esc(run.terminalAt)}</td>
      <td>${run.costMicroUsd === null ? "—" : `$${esc(formatMicroUsd(run.costMicroUsd))}`}</td>
      <td class="mono">${run.origin === null ? "—" : esc(run.origin)}</td>
      <td><a href="${esc(compareLinkOf(run.id))}">Compare</a></td>
    </tr>`,
    )
    .join("\n  ");
  return `<table class="data">
  <thead><tr><th scope="col">Execution</th><th scope="col">Status</th><th scope="col">Workload family</th><th scope="col">Created</th><th scope="col">Terminal</th><th scope="col">Recorded cost</th><th scope="col">Origin</th><th scope="col">Compare</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

async function executionsConsolePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const { executions, survivingIds } = await readRecentExecutions(client, ids);
  const results = await readResults(client, survivingIds);
  const runs = explorerRunsOf(executions, results);
  const setCookies =
    survivingIds.length === ids.length ? undefined : [recentsCookieHeader(survivingIds)];
  const content = `${pageHead({
    title: "Executions",
    path: "/console/executions",
    primaryActionHtml: '<a class="button-link" href="/console/compare">Compare runs</a>',
  })}
<p class="muted">The complete execution explorer — every execution you open, inspected through the public contracts: result, verification, activity, route and substrate, costs and provenance.</p>
${unavailableState(
  "No application-scoped execution listing exists in the public API",
  "The list below is this browser's disclosed recents — each row is re-read live through GET /executions/:id. The public API exposes no listing route yet; when it does, this page projects it (DEP-012's honest boundary).",
  "GET /executions (listing)",
)}
${explorerListRows(runs)}
${lookupForm()}
<p class="muted">Machine parity: every execution's composed public facts are served as verbatim JSON at <span class="mono">/console/executions/&lt;id&gt;/facts.json</span> — an agent follows an execution without scraping HTML. Compare: select two runs (the Compare column pins run a) and open <a href="/console/compare">the compare view</a> — side by side, with the platform's own recorded planning explanation.</p>`;
  return page(
    { title: "Zeck — Executions", activePath: "/console/executions", mainContent: content },
    ctx,
    { setCookies },
  );
}

async function executionExplorerPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const executionId = ctx.params.executionId ?? "";
  let facts: ExplorerFacts;
  try {
    const [execution, result, events, verification] = await Promise.all([
      client.getExecution(executionId),
      client.getResult(executionId),
      client.listEvents(executionId),
      client.listVerification(executionId),
    ]);
    facts = { execution, result, events, verification };
  } catch (error) {
    if (error instanceof ZeckApiError && error.status === 404) {
      const content = `${pageHead({ title: "Execution not found", path: "/console/executions" })}
${explorerNotFoundView(executionId)}
${lookupForm()}`;
      return htmlStatusResult(
        404,
        appShell({
          title: "Zeck — Execution not found",
          activePath: "/console/executions",
          mainContent: content,
          appearance: appearanceOf(ctx.cookies),
          mode: modeOf(ctx.cookies),
          returnTo: ctx.path,
        }),
      );
    }
    throw error;
  }
  const view = explorerViewOf(ctx.query.get("tab"));
  const setCookies = [
    recentsCookieHeader(addRecent(parseRecents(ctx.cookies[RECENTS_COOKIE]), facts.execution.id)),
  ];
  const content = `${pageHead({
    title: `Execution ${facts.execution.id}`,
    path: "/console/executions",
    currentLabel: facts.execution.id,
    headingHtml: `${esc(facts.execution.id)}\n    ${statusBadge(facts.execution.status)}`,
    primaryActionHtml: explorerExportAction(facts.execution.id),
  })}
<p class="muted">Workload family <strong>${esc(explorerFamilyOf(facts.execution))}</strong> · recorded facts only — every missing fact names its missing public contract.</p>
${explorerTabNav(facts.execution.id, view)}
${explorerView(view, facts)}
<p class="muted">Machine parity: <a href="/console/executions/${encodeURIComponent(
    facts.execution.id,
  )}/facts.json">the composed public facts as verbatim JSON</a> · reproducibility: <a href="/console/executions/${encodeURIComponent(
    facts.execution.id,
  )}/export">export the bundle</a> (the same facts plus the reproduction recipe) · compare: <a href="${esc(
    compareLinkOf(facts.execution.id),
  )}">pick a second run</a> and see both side by side.</p>`;
  return page(
    {
      title: `Zeck — Execution ${facts.execution.id}`,
      activePath: "/console/executions",
      mainContent: content,
    },
    ctx,
    { setCookies },
  );
}

async function executionFactsRoute(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const executionId = ctx.params.executionId ?? "";
  let facts: ExplorerFacts;
  try {
    const [execution, result, events, verification] = await Promise.all([
      client.getExecution(executionId),
      client.getResult(executionId),
      client.listEvents(executionId),
      client.listVerification(executionId),
    ]);
    facts = { execution, result, events, verification };
  } catch (error) {
    if (error instanceof ZeckApiError && error.status === 404) {
      return jsonResult(
        JSON.stringify(
          {
            error: "NOT_FOUND",
            message: `No execution "${executionId}" is visible through the governed API for this token.`,
          },
          null,
          2,
        ),
        404,
      );
    }
    throw error;
  }
  return jsonResult(JSON.stringify(explorerFactsOf(facts), null, 2));
}

// The reproducibility-bundle export (DEP-032): the SAME public-record
// read the explorer performs, composed into the bundle (machine view +
// recipe) and rendered by apps/dashboard/export.ts — there is no second
// composition on this side of the wire.

async function readExplorerFacts(
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

async function executionExportPage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const executionId = ctx.params.executionId ?? "";
  const facts = await readExplorerFacts(client, executionId);
  if (facts === null) {
    const content = `${pageHead({ title: "Execution not found", path: "/console/executions" })}
${exportNotFoundView(executionId)}
${lookupForm()}`;
    return htmlStatusResult(
      404,
      appShell({
        title: "Zeck — Execution not found",
        activePath: "/console/executions",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  const bundle = reproducibilityBundleOf(facts);
  const content = `${pageHead({
    title: `Export — ${facts.execution.id}`,
    path: "/console/executions",
    currentLabel: facts.execution.id,
    primaryActionHtml: `<a class="button-link" href="/console/executions/${encodeURIComponent(
      facts.execution.id,
    )}">Back to the execution</a>`,
  })}
${executionExportView(bundle)}`;
  return page(
    {
      title: `Zeck — Export ${facts.execution.id}`,
      activePath: "/console/executions",
      mainContent: content,
    },
    ctx,
  );
}

async function executionExportBundleRoute(
  client: ZeckClient,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const executionId = ctx.params.executionId ?? "";
  const facts = await readExplorerFacts(client, executionId);
  if (facts === null) {
    return jsonResult(
      JSON.stringify(
        {
          error: "NOT_FOUND",
          message: `No execution "${executionId}" is visible through the governed API for this token — there is nothing to export.`,
        },
        null,
        2,
      ),
      404,
    );
  }
  return jsonResult(JSON.stringify(reproducibilityBundleOf(facts), null, 2));
}

async function validationLabPage(ctx: HttpContext): Promise<HandlerResult> {
  const experiments = validationExperiments();
  const content = `${pageHead({
    title: "Validation Lab",
    path: "/console/validation",
    primaryActionHtml:
      '<a class="button-link primary" href="/console/validation/start">Recommended starting points</a>',
  })}
<p>The complete executed Zeck validation program — every work order VAL-001..VAL-052 the governed state records, projected from repository truth: the work-order specs (objectives), the immutable evidence documents, the golden corpus, the capability matrix and the recorded validation report. Historical evidence is read-only; every rerun creates a NEW governed execution linked to the definition through its lineage metadata.</p>
${validationTabNav("all")}
<h2>The catalog</h2>
${validationExperimentRows(experiments)}
<h2>Program facts</h2>
${validationProgramFacts()}
${validationProviderTable()}
${validationBoundaryInventory()}
<p class="muted">Machine interface: <a href="/console/validation/api/catalog.json">catalog.json</a> · <a href="/console/validation/api/schema.json">schema.json</a> · the <a href="/console/validation/agent">agent guide</a>. Every page of this lab is the same projection the machine routes serve — there is no console-only source of truth.</p>`;
  return page(
    { title: "Zeck — Validation Lab", activePath: "/console/validation", mainContent: content },
    ctx,
  );
}

async function validationStagePage(ctx: HttpContext): Promise<HandlerResult> {
  const sections = experimentsByStage()
    .map(
      (section) => `<section class="card">
  <h2>${esc(section.stage)}</h2>
  ${validationExperimentRows(section.experiments)}
</section>`,
    )
    .join("\n");
  const content = `${pageHead({
    title: "Validation Lab — by stage",
    path: "/console/validation",
    currentLabel: "By validation stage",
  })}
<p>The validation roadmap's own stage vocabulary — the ranges are parsed from the roadmap's stage block, never re-typed here. Each stage lists its experiments in governed id order.</p>
${validationTabNav("stage")}
${sections}`;
  return page(
    {
      title: "Zeck — Validation Lab by stage",
      activePath: "/console/validation",
      mainContent: content,
    },
    ctx,
  );
}

async function validationCapabilityPage(ctx: HttpContext): Promise<HandlerResult> {
  const matrixRows = `<table class="data">
  <thead><tr><th scope="col">Capability</th><th scope="col">Required by (corpus families)</th><th scope="col">Candidate access</th><th scope="col">Experiments</th></tr></thead>
  <tbody>${capabilityMatrixRows()
    .map(
      (row) => `<tr>
      <td class="mono">${esc(row.capability)}</td>
      <td>${row.requiredBy.map((family) => esc(family)).join(", ")}</td>
      <td>${
        row.candidates.length === 0
          ? '<span class="muted">no candidate provider in the authorized set</span>'
          : esc(row.accessRequirement)
      }</td>
      <td>${
        row.experiments.length === 0
          ? '<span class="muted">—</span>'
          : row.experiments
              .map(
                (experiment) =>
                  `<a href="/console/validation/${encodeURIComponent(experiment.id)}">${esc(experiment.id)}</a>`,
              )
              .join(", ")
      }</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
  const accessRows = `<table class="data">
  <thead><tr><th scope="col">Provider</th><th scope="col">Credential env var (name only)</th><th scope="col">A successful base probe certifies</th></tr></thead>
  <tbody>${providerAccessRows()
    .map(
      (row) => `<tr>
      <td>${esc(row.provider)}</td>
      <td class="mono">${esc(row.credentialEnvVar)}</td>
      <td>${esc(row.probeSummary)}</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
  const content = `${pageHead({
    title: "Validation Lab — by capability",
    path: "/console/validation",
    currentLabel: "By capability",
  })}
<p>The capability matrix the validation program probed (VAL-009): every capability the golden corpus declares, the workload families that require it and its candidate provider access. Readiness was resolved ONLY from probe outcomes — a capability without a successful probe is a gap, never a silent pass.</p>
${validationTabNav("capability")}
<h2>The capability matrix</h2>
${matrixRows}
<h2>Provider access (credential NAMES only)</h2>
${accessRows}
${validationProviderTable()}`;
  return page(
    {
      title: "Zeck — Validation Lab by capability",
      activePath: "/console/validation",
      mainContent: content,
    },
    ctx,
  );
}

async function validationWorkloadPage(ctx: HttpContext): Promise<HandlerResult> {
  const families = new Map<string, readonly ValidationExperiment[]>();
  for (const experiment of validationExperiments()) {
    for (const family of experiment.families) {
      const existing = families.get(family) ?? [];
      families.set(family, [...existing, experiment]);
    }
  }
  const workloadRows = `<table class="data">
  <thead><tr><th scope="col">Workload family</th><th scope="col">Corpus tasks</th><th scope="col">Experiments</th></tr></thead>
  <tbody>${[...families.keys()]
    .sort()
    .map(
      (family) => `<tr>
      <td class="mono">${esc(family)}</td>
      <td>${String(familyTaskCountOf(family))}</td>
      <td>${(families.get(family) ?? [])
        .map(
          (experiment) =>
            `<a href="/console/validation/${encodeURIComponent(experiment.id)}">${esc(experiment.id)}</a>`,
        )
        .join(", ")}</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
  const content = `${pageHead({
    title: "Validation Lab — by workload",
    path: "/console/validation",
    currentLabel: "By workload",
  })}
<p>The golden corpus's own workload-family registry (22 families, append-only), crossed with the experiments whose applications exercise them. Applications with an app-local deterministic corpus derive their family mechanically (README scenario/kind tokens and the app directory's own name); an experiment no rule can place stays on the suite-reproduction path, honestly.</p>
${validationTabNav("workload")}
<h2>Families × experiments</h2>
${workloadRows}
${validationBoundaryInventory()}`;
  return page(
    {
      title: "Zeck — Validation Lab by workload",
      activePath: "/console/validation",
      mainContent: content,
    },
    ctx,
  );
}

async function validationStartPage(ctx: HttpContext): Promise<HandlerResult> {
  const recommended = recommendedExperiments();
  const cards = recommended
    .map((experiment) => {
      const task = defaultTaskOf(experiment);
      const coverage = experiment.recordedCoverage[0];
      return `<section class="tile">
  <h3><a href="/console/validation/${encodeURIComponent(experiment.id)}">${esc(
    experiment.id,
  )} — ${esc(experiment.title)}</a></h3>
  <p>${esc(experiment.objective)}</p>
  <p class="muted">${
    task === null ? "" : `Default corpus task <span class="mono">${esc(task.taskId)}</span> · `
  }${coverage === undefined ? "" : `${esc(coverage.runs)} · ${esc(coverage.status)} · `}stage: ${esc(
    experiment.stage,
  )}</p>
</section>`;
    })
    .join("\n");
  const content = `${pageHead({
    title: "Validation Lab — recommended starting points",
    path: "/console/validation",
    currentLabel: "Recommended starting points",
    primaryActionHtml:
      '<a class="button-link primary" href="/console/validation/VAL-010">Open VAL-010 (the text portfolio)</a>',
  })}
<p>Where to start: the experiments that are console-rerunnable, whose recorded coverage completed live, and whose required capabilities all have candidate provider access in the capability matrix. Every one of them opens with its objective, its original evidence and a governed replay form.</p>
${validationTabNav("start")}
<div class="tiles">
${cards}
</div>
${validationBoundaryInventory()}`;
  return page(
    {
      title: "Zeck — Validation Lab starting points",
      activePath: "/console/validation",
      mainContent: content,
    },
    ctx,
  );
}

async function validationAgentPage(ctx: HttpContext): Promise<HandlerResult> {
  const steps = [
    [
      "1. List",
      "GET /console/validation/api/catalog.json",
      "every experiment: stages, definitions, availability, boundaries",
    ],
    [
      "2. Inspect",
      "GET /console/validation/api/VAL-010.json",
      "one definition: objective, tasks, expected outcomes, access, cost, run fields",
    ],
    [
      "3. Check access",
      "availability on the definition",
      "missingEnvVars names the exact credential NAMES absent from the deployment; hardBlocked names capabilities with no candidate provider",
    ],
    [
      "4. Estimate cost",
      "costEstimate on the definition",
      "the binding hard ceilings plus the recorded validation-program costs where measured",
    ],
    [
      "5. Start run",
      "POST /console/validation/VAL-010/run",
      "urlencoded form: applicationId, environmentId, spendLimitDollars, mode, taskId, idempotencyKey, format",
    ],
    [
      "6. Poll / retrieve",
      "GET /console/validation/api/runs/{executionId}.json",
      "status, outcome, verification, cost, latency, trajectory, lineage, comparisonToExpectation",
    ],
    [
      "7. Compare",
      "GET /console/validation/compare?runs={id1},{id2}",
      "side-by-side comparison against the corpus's recorded expectation",
    ],
    [
      "8. Export",
      "GET /console/validation/api/VAL-010/bundle.json",
      "the reproducibility bundle: definition + evidence + reproduction suites + boundaries",
    ],
  ];
  const content = `${pageHead({
    title: "Validation Lab — agent / machine interface",
    path: "/console/validation",
    currentLabel: "Agent / machine interface",
    primaryActionHtml:
      '<a class="button-link primary" href="/console/validation/api/catalog.json">catalog.json</a>',
  })}
<p>The same projected catalog the human console renders, served as machine-readable JSON — an agent can discover, inspect, check access, estimate, start, poll, retrieve, compare and export without any UI-only state. The schema document describes every shape: <a href="/console/validation/api/schema.json">schema.json</a>.</p>
${validationTabNav("agent")}
<h2>The agent journey</h2>
<table class="data">
  <thead><tr><th scope="col">Step</th><th scope="col">Interface</th><th scope="col">Returns</th></tr></thead>
  <tbody>${steps
    .map(
      ([step, api, returns]) => `<tr>
    <td>${esc(step)}</td>
    <td class="mono">${esc(api)}</td>
    <td>${esc(returns)}</td>
  </tr>`,
    )
    .join("")}</tbody>
</table>
<h2>Starting a run (the governed POST)</h2>
<pre class="raw">curl -X POST "$ZECK_CONSOLE/console/validation/VAL-010/run" \\
  -H "content-type: application/x-www-form-urlencoded" \\
  --data-urlencode "applicationId=$ZECK_APPLICATION_ID" \\
  --data-urlencode "mode=replay-exact" \\
  --data-urlencode "taskId=text.summarize-doc.v1#000" \\
  --data-urlencode "idempotencyKey=agent-val-010-1" \\
  --data-urlencode "format=json"</pre>
<p class="muted">The response is a 303 redirect to the run page (HTML agents) or, with format=json, a 200 JSON receipt carrying the execution id and the run-record URL. Every run is an ordinary governed execution — the hard budget/latency constraints and the disposable-sandbox lineage ride the request itself, provider selection is structurally impossible, and the platform's policy admission stays the final gate.</p>
<h2>Sandbox envelope</h2>
${keyValueTable([
  [
    "Budget ceiling",
    `$${VALIDATION_BUDGET_LIMIT_DOLLARS} per run (the request always carries the cost constraint)`,
  ],
  [
    "Latency ceiling",
    `${String(VALIDATION_LATENCY_LIMIT_MS / 1000)} seconds per run (replay-exact honors the corpus row's recorded target when lower)`,
  ],
  [
    "Concurrency",
    `at most ${String(VALIDATION_MAX_CONCURRENT_RUNS)} in-flight sandbox runs per browser`,
  ],
  ["Data", "synthetic — the golden corpus's authored inputs, verbatim"],
  ["Identity", `${VALIDATION_LAB_ORIGIN} (disposable)`],
  ["Side effects", "behind the platform's policy admission and approval gates"],
])}
${validationBoundaryInventory()}`;
  return page(
    {
      title: "Zeck — Validation Lab agent interface",
      activePath: "/console/validation",
      mainContent: content,
    },
    ctx,
  );
}

async function validationEvidencePage(ctx: HttpContext): Promise<HandlerResult> {
  const workOrder = ctx.params.workOrder ?? "";
  const evidence = readValidationEvidence(workOrder);
  if (evidence === null) {
    const content = `${pageHead({ title: "Evidence not found", path: "/console/validation" })}
${errorState(
  "No such validation experiment",
  `The governed program state records no experiment "${workOrder}" — the console projects the program and invents nothing.`,
  "spec/validation-state/program-state.json (the governed state)",
)}
<p><a href="/console/validation">Back to the Validation Lab catalog</a></p>`;
    return htmlStatusResult(
      404,
      appShell({
        title: "Zeck — Evidence not found",
        activePath: "/console/validation",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  const content = `${pageHead({
    title: `Evidence — ${evidence.experiment.id}`,
    path: "/console/validation",
    currentLabel: `${evidence.experiment.id} evidence`,
    primaryActionHtml: `<a class="button-link" href="/console/validation/${encodeURIComponent(
      evidence.experiment.id,
    )}">The experiment</a>`,
  })}
<p class="muted mono">${esc(evidence.experiment.evidencePath)} — served verbatim from the repository; read-only forever (a rerun never mutates historical evidence).</p>
<pre class="raw">${esc(evidence.content)}</pre>`;
  return page(
    {
      title: `Zeck — ${evidence.experiment.id} evidence`,
      activePath: "/console/validation",
      mainContent: content,
    },
    ctx,
  );
}

function validationExperimentNotFoundView(workOrderId: string, ctx: HttpContext): HandlerResult {
  const content = `${pageHead({ title: "Experiment not found", path: "/console/validation" })}
${errorState(
  "No such validation experiment",
  `The governed program state records no experiment "${workOrderId}" — the console projects the program and invents nothing.`,
  "spec/validation-state/program-state.json (the governed state)",
)}
<p><a href="/console/validation">Back to the Validation Lab catalog</a></p>`;
  return htmlStatusResult(
    404,
    appShell({
      title: "Zeck — Experiment not found",
      activePath: "/console/validation",
      mainContent: content,
      appearance: appearanceOf(ctx.cookies),
      mode: modeOf(ctx.cookies),
      returnTo: ctx.path,
    }),
  );
}

/** The experiment's required-access panel (the AC6 pre-execution surface). */
function validationAccessSection(experiment: ValidationExperiment): string {
  const availability = availabilityOf(experiment);
  const accessRows = `<table class="data">
  <thead><tr><th scope="col">Capability</th><th scope="col">Access requirement</th><th scope="col">Candidate credentials (names)</th><th scope="col">In this deployment</th></tr></thead>
  <tbody>${availability.access
    .map(
      (fact) => `<tr>
      <td class="mono">${esc(fact.capability)}</td>
      <td>${esc(fact.accessRequirement)}</td>
      <td>${
        fact.candidateEnvVars.length === 0
          ? '<span class="muted">no candidate provider recorded</span>'
          : fact.candidateEnvVars.map((name) => `<span class="mono">${esc(name)}</span>`).join(", ")
      }</td>
      <td>${
        fact.candidateEnvVars.length === 0
          ? "—"
          : fact.candidateEnvVars
              .map((name) =>
                availability.presentEnvVars.includes(name)
                  ? `<span class="mono">${esc(name)}</span> present`
                  : `<span class="mono">${esc(name)}</span> absent`,
              )
              .join("; ")
      }</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
  const blocked =
    availability.hardBlocked.length === 0
      ? ""
      : `\n${availability.hardBlocked
          .map(
            (block) => `<div class="state state-blocked">
  <p class="state-title">NOT RUN — ${esc(block.capability)} has no provider in the authorized set</p>
  <p class="state-body">${esc(block.reason)} ${esc(block.accessRequirement)}</p>
  <p class="state-source">The recorded boundary and its gating credential are named in the validation report's NOT RUN inventory — never converted into a pass; the Lead owns the credentialed re-run.</p>
</div>`,
          )
          .join("\n")}`;
  const missing =
    availability.missingEnvVars.length === 0
      ? ""
      : `<p class="muted">Absent in this deployment's environment: ${availability.missingEnvVars
          .map((name) => `<span class="mono">${esc(name)}</span>`)
          .join(
            ", ",
          )} (names only — values are never read, never rendered). A console rerun still submits through the governed API with synthetic data; the platform's authorized rails and policy admission decide the outcome, and a missing-rail outcome is recorded as it occurs — never represented as PASS.</p>`;
  return `<section class="card">
  <h2>Required access</h2>
  ${availability.access.length === 0 ? '<p class="muted">No live provider dependency — this experiment reproduces through the repository suites.</p>' : accessRows}
  ${blocked}
  ${missing}
</section>`;
}

function validationModeDescription(mode: string): string {
  if (mode === "replay-exact") {
    return "same definition, pinned corpus task, the corpus row's recorded latency target where one exists — the closest reproduction of the original run's configuration";
  }
  if (mode === "rerun-current") {
    return "same definition against the CURRENT platform — the sandbox ceiling applies, the run records what the platform does today";
  }
  return "your changes (a different corpus task of the experiment's families, a lower spend ceiling) with the lineage to the original definition preserved in the run's metadata";
}

function validationEditLink(
  experiment: ValidationExperiment,
  values: Record<string, string>,
  idempotencyKey: string,
): string {
  const params = new URLSearchParams();
  for (const key of VALIDATION_FORM_KEYS) {
    params.set(key, values[key] ?? "");
  }
  params.set("edit", "1");
  params.set("idempotencyKey", idempotencyKey);
  return `/console/validation/${encodeURIComponent(experiment.id)}?${params.toString()}`;
}

/** The rerun composer (constraints only — the task is the corpus's synthetic input). */
function validationRunForm(
  experiment: ValidationExperiment,
  defaultTaskId: string,
  values: Record<string, string>,
  errors: Record<string, string | undefined>,
  idempotencyKey: string,
): string {
  const taskOptions = tasksOfExperiment(experiment)
    .map(
      (task) =>
        `<option value="${esc(task.taskId)}"${values.taskId === task.taskId ? " selected" : ""}>${esc(
          `${task.taskId} — ${task.description}`,
        )}</option>`,
    )
    .join("");
  const modeOptions = VALIDATION_RUN_MODES.map(
    (mode) =>
      `<option value="${esc(mode)}"${values.mode === mode ? " selected" : ""}>${esc(mode)} — ${esc(
        validationModeDescription(mode),
      )}</option>`,
  ).join("");
  return `<form class="flow card" method="get" action="/console/validation/${encodeURIComponent(
    experiment.id,
  )}">
  <input type="hidden" name="idempotencyKey" value="${esc(idempotencyKey)}">
  ${executionFormField(
    "vf-application",
    "Application id",
    `<input id="vf-application" name="applicationId" value="${esc(
      values.applicationId ?? "",
    )}" required>`,
    "The governed application scope the rerun (and any spend) belongs to.",
    errors.applicationId,
  )}
  ${executionFormField(
    "vf-environment",
    "Compute environment (optional)",
    `<input id="vf-environment" name="environmentId" value="${esc(values.environmentId ?? "")}">`,
    "Leave empty for the default environment; a disposable sandbox environment id goes here.",
    errors.environmentId,
  )}
  ${executionFormField(
    "vf-mode",
    "Rerun mode",
    `<select id="vf-mode" name="mode">${modeOptions}</select>`,
    "The contract's rerun vocabulary — every mode creates a NEW immutable run identity linked to this definition.",
    errors.mode,
  )}
  ${executionFormField(
    "vf-task",
    "Corpus task",
    `<select id="vf-task" name="taskId">${taskOptions}</select>`,
    `The golden corpus's synthetic task, verbatim. The pinned default is ${defaultTaskId}.`,
    errors.taskId,
  )}
  ${executionFormField(
    "vf-spend",
    `Spend limit (dollars, optional — validation ceiling $${VALIDATION_BUDGET_LIMIT_DOLLARS})`,
    `<input id="vf-spend" name="spendLimitDollars" value="${esc(
      values.spendLimitDollars ?? "",
    )}" inputmode="decimal" placeholder="1.50">`,
    `Sent as the per-run cost constraint. The $${VALIDATION_BUDGET_LIMIT_DOLLARS} ceiling is enforced either way; a higher entry is refused before any wire call.`,
    errors.spendLimitDollars,
  )}
  <div class="form-actions"><button type="submit" class="primary">Review the rerun</button></div>
</form>`;
}

function validationEnvelope(
  request: ExecutionRequest,
  task: { readonly taskId: string; readonly latencyTargetMs?: number },
): string {
  const constraints = request.constraints ?? {};
  const metadata = request.metadata as Readonly<Record<string, unknown>>;
  return `<div class="card review-envelope">
  <h2>Proposed validation rerun</h2>
  <h3>The synthetic corpus task (verbatim from the golden corpus)</h3>
  ${keyValueTable(safeTaskPairs(request.task))}
  <h3>The rerun mode</h3>
  <p>${esc(validationModeDescription(String(metadata.mode ?? "")))}</p>
  <h3>Sandbox constraints</h3>
  ${keyValueTable([
    [
      "Cost ceiling",
      formatMicroUsd(constraints.maxCostMicroUsd ?? VALIDATION_BUDGET_LIMIT_MICRO_USD),
    ],
    [
      "Latency ceiling",
      constraints.maxLatencyMs === task.latencyTargetMs && task.latencyTargetMs !== undefined
        ? `${String(constraints.maxLatencyMs)} ms (the corpus row's recorded target)`
        : `${String(constraints.maxLatencyMs ?? VALIDATION_LATENCY_LIMIT_MS)} ms (the sandbox ceiling)`,
    ],
    ["Sandbox identity", `${VALIDATION_LAB_ORIGIN} (disposable)`],
  ])}
  <h3>Lineage metadata (links this NEW run to the immutable definition)</h3>
  ${keyValueTable(Object.keys(metadata).map((key) => [key, String(metadata[key] ?? "")] as const))}
  <p class="muted">No provider, model, rail, connection or agent is selected — the frozen create contract forbids provider selection, and Zeck owns the route. Policy admission is decided platform-side at dispatch. Historical evidence is never touched.</p>
</div>`;
}

function validationCommitmentCard(
  experiment: ValidationExperiment,
  values: Record<string, string>,
  request: ExecutionRequest,
  idempotencyKey: string,
  confirmLabel: string,
): string {
  const constraints = request.constraints ?? {};
  return confirmationCard({
    title: "Run this validation rerun?",
    consequence: `The rerun submits the governed create request for ${experiment.id}'s corpus task: exactly ONE new execution is created — its own immutable run identity — and its lineage metadata links it to the definition (work order ${experiment.id}, definition revision ${experiment.definitionRevision}). The events, verification results, output artifacts and settled cost are recorded platform-side; you follow the run on its execution page. The historical evidence document stays read-only.`,
    affected: `A governed execution record in application ${values.applicationId ?? ""}${
      (values.environmentId ?? "").length > 0
        ? `, environment ${values.environmentId ?? ""}`
        : " (default environment)"
    }.`,
    cost: `Spend ceiling ${formatMicroUsd(
      constraints.maxCostMicroUsd ?? VALIDATION_BUDGET_LIMIT_MICRO_USD,
    )} and latency ceiling ${String(
      Math.round((constraints.maxLatencyMs ?? VALIDATION_LATENCY_LIMIT_MS) / 1000),
    )} seconds — the request's own constraints. No pre-run estimate exists; the settled cost is recorded per execution.`,
    whyAllowed:
      "The create request is valid against the frozen create contract — it selects no provider, model, rail, connection or agent (selection is forbidden; the platform plans the route), and policy admission is decided platform-side at dispatch: a denial is surfaced on the execution, never silently retried.",
    reversible: false,
    reversibleDetail:
      "No — a committed execution cannot be undone through the public contract. The governed stop is Cancel (its own consequence preview); work already performed and its evidence stay recorded and inspectable.",
    approvalNote:
      "No user pre-approval is part of the public create contract — the platform's policy admission at dispatch is the authorization boundary.",
    idempotencyNote: `The idempotency key ${idempotencyKey} is carried: resubmitting the same request converges on ONE execution rather than creating duplicates.`,
    hiddenFields: VALIDATION_FORM_KEYS.filter(
      (key) => key !== "idempotencyKey" || (values[key] ?? "").length > 0,
    ).map((key) => [key, values[key] ?? ""] as const),
    confirmAction: `/console/validation/${encodeURIComponent(experiment.id)}/run`,
    confirmLabel,
    cancelHref: validationEditLink(experiment, values, idempotencyKey),
  });
}

function validationConcurrencyGate(inFlight: number): string {
  return `<div class="state state-blocked">
  <p class="state-title">Sandbox concurrency limit reached</p>
  <p class="state-body">${inFlight} sandbox runs opened in this browser are still in flight (the limit is ${String(
    VALIDATION_MAX_CONCURRENT_RUNS,
  )}). The console refuses to submit another until one finishes or is cancelled — uncontrolled spend and side effects are prevented by default, and this gate holds no server-side state: it is derived live from the runs this browser opened.</p>
  <p class="state-source">Open the active runs to wait or cancel: <a href="/runs/active">Active runs</a>.</p>
</div>`;
}

function validationHistorySection(
  experiment: ValidationExperiment,
  runs: readonly {
    readonly executionId: string;
    readonly mode: string | null;
    readonly corpusTask: string | null;
    readonly status: string;
    readonly createdAt: string;
  }[],
): string {
  if (runs.length === 0) {
    return emptyState(
      "No reruns of this experiment yet in this browser",
      "The run history is derived live from the executions this browser opened (navigation-only; every view reads through the governed API). Launch a rerun above and it appears here.",
    );
  }
  const compareLink = `/console/validation/compare?runs=${runs
    .slice(0, 4)
    .map((run) => encodeURIComponent(run.executionId))
    .join(",")}&amp;workOrder=${encodeURIComponent(experiment.id)}`;
  return `<table class="data">
  <thead><tr><th scope="col">Run</th><th scope="col">Mode</th><th scope="col">Corpus task</th><th scope="col">Status</th><th scope="col">Opened</th></tr></thead>
  <tbody>${runs
    .map(
      (run) => `<tr>
      <td><a href="/runs/${encodeURIComponent(run.executionId)}" class="mono">${esc(
        run.executionId,
      )}</a></td>
      <td>${esc(run.mode ?? "—")}</td>
      <td class="mono">${esc(run.corpusTask ?? "—")}</td>
      <td>${statusBadge(run.status)}</td>
      <td>${esc(run.createdAt)}</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>
<p><a class="button-link" href="${compareLink}">Compare these runs</a></p>`;
}

async function validationExperimentPage(
  client: ZeckClient,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const workOrderId = ctx.params.workOrder ?? "";
  const experiment = experimentOf(workOrderId);
  if (experiment === null) {
    return validationExperimentNotFoundView(workOrderId, ctx);
  }
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const setCookies = recents.pruned ? [recentsCookieHeader(recents.survivingIds)] : undefined;
  const history = validationRunsForWorkOrder(recents.executions, experiment.id);
  const inFlight = inFlightCount(recents.executions);
  const gated = inFlight >= VALIDATION_MAX_CONCURRENT_RUNS;
  const availability = availabilityOf(experiment);
  const rerunnable = experimentIsRerunnable(experiment);
  const defaultTask = defaultTaskOf(experiment);
  const query: Record<string, string> = {};
  for (const key of [...VALIDATION_FORM_KEYS, "edit"]) {
    const value = ctx.query.get(key);
    if (value !== null) {
      query[key] = value;
    }
  }
  const idempotencyKey =
    (query.idempotencyKey ?? "").length > 0
      ? (query.idempotencyKey ?? "")
      : `dash-${crypto.randomUUID()}`;
  const submitted = (query.applicationId ?? "").trim().length > 0;
  const applicationId = query.applicationId ?? scope;
  const values: Record<string, string> = {
    applicationId,
    environmentId: query.environmentId ?? "",
    spendLimitDollars: query.spendLimitDollars ?? "",
    mode: query.mode ?? "replay-exact",
    taskId: query.taskId ?? defaultTask?.taskId ?? "",
    idempotencyKey,
  };
  const reviewable = submitted && query.edit !== "1";
  let runSurface: string;
  if (!rerunnable || defaultTask === null) {
    runSurface = `<div class="state state-unavailable">
  <p class="state-title">Console rerun — NOT RUN for this experiment</p>
  <p class="state-body">This experiment's applications pin an app-local deterministic corpus or a multi-run orchestration the console cannot honestly reproduce as one governed execution. Its reproduction path is the repository's governed suites${
    experiment.apps.some((app) => app.suitePath !== null)
      ? ` (${experiment.apps
          .map((app) => app.suitePath)
          .filter((path): path is string => path !== null)
          .map((path) => `<span class="mono">${esc(path)}</span>`)
          .join(", ")})`
      : ""
  } — the full battery re-run is the Lead's credentialed environment. The definition, evidence and reproducibility bundle below are still complete.</p>
  <p class="state-source">Export the bundle: <a href="/console/validation/api/${encodeURIComponent(
    experiment.id,
  )}/bundle.json">${esc(experiment.id)} bundle.json</a></p>
</div>`;
  } else if (availability.hardBlocked.length > 0) {
    runSurface = validationAccessSection(experiment);
  } else if (gated) {
    runSurface = validationConcurrencyGate(inFlight);
  } else if (!reviewable) {
    runSurface = validationRunForm(experiment, defaultTask.taskId, values, {}, idempotencyKey);
  } else {
    const validation = validateValidationRunForm(experiment, query);
    if (validation.values === null) {
      runSurface = validationRunForm(
        experiment,
        defaultTask.taskId,
        values,
        validation.errors,
        idempotencyKey,
      );
    } else {
      const task =
        tasksOfExperiment(experiment).find(
          (candidate) => candidate.taskId === validation.values?.taskId,
        ) ?? defaultTask;
      const request = buildValidationRunRequest(experiment, task, validation.values);
      runSurface = `${validationEnvelope(request, task)}
${validationCommitmentCard(experiment, values, request, idempotencyKey, "Run validation rerun")}`;
    }
  }
  const coverageSection =
    experiment.recordedCoverage.length === 0
      ? ""
      : `<h2>Recorded coverage (verbatim from the validation report)</h2>
<table class="data">
  <thead><tr><th scope="col">Workload</th><th scope="col">Runs</th><th scope="col">Quality</th><th scope="col">Cost/success</th><th scope="col">Status</th></tr></thead>
  <tbody>${experiment.recordedCoverage
    .map(
      (row) => `<tr>
    <td>${esc(row.workload)}</td>
    <td>${esc(row.runs)}</td>
    <td>${esc(row.quality)}</td>
    <td>${esc(row.costPerSuccess)}</td>
    <td>${esc(row.status)}</td>
  </tr>`,
    )
    .join("")}</tbody>
</table>`;
  const tasksDisclosure = rerunnable
    ? advancedDisclosure(
        `Every corpus task of this experiment (${String(experiment.corpusTaskCount)})`,
        `<table class="data">
  <thead><tr><th scope="col">Task</th><th scope="col">Expected terminal</th><th scope="col">Expected verification</th><th scope="col">Evaluation</th><th scope="col">Latency target</th></tr></thead>
  <tbody>${tasksOfExperiment(experiment)
    .map(
      (task) => `<tr>
    <td class="mono">${esc(task.taskId)}</td>
    <td>${esc(task.expectedOutcome.terminalStatus)}</td>
    <td>${esc(task.expectedOutcome.verification ?? "—")}</td>
    <td>${esc(task.evaluation.method)}</td>
    <td>${task.latencyTargetMs === undefined ? "—" : `${String(task.latencyTargetMs)} ms`}</td>
  </tr>`,
    )
    .join("")}</tbody>
</table>`,
      )
    : "";
  const sdkExample =
    rerunnable && defaultTask !== null
      ? `<h2>The copyable SDK example</h2>
<p class="muted">Composed from the projected definition — the exact governed create request a console replay submits (the same wire contract the repository examples ride).</p>
<pre class="raw">${esc(sdkExampleOf(experiment, defaultTask))}</pre>`
      : "";
  const content = `${pageHead({
    title: `${experiment.id} — ${experiment.title}`,
    path: "/console/validation",
    currentLabel: experiment.id,
    primaryActionHtml: `<a class="button-link" href="/console/validation/evidence/${encodeURIComponent(
      experiment.id,
    )}">The original evidence</a>`,
  })}
${validationTabNav("all")}
<section class="card">
  <h2>What it proves</h2>
  <p>${esc(experiment.objective)}</p>
  ${keyValueTable([
    ["Stage", experiment.stage],
    ["Governed status", experiment.status],
    ["Definition revision", `${experiment.definitionRevision} (merge of record)`],
    [
      "Dependencies",
      experiment.dependencies.length === 0 ? "—" : experiment.dependencies.join(", "),
    ],
    ["Spec", experiment.specPath],
    ["Evidence", experiment.evidencePath],
  ])}
</section>
<h2>Original evidence (immutable, read-only)</h2>
<p>Served verbatim from the repository — a rerun never mutates it. <a href="/console/validation/evidence/${encodeURIComponent(
    experiment.id,
  )}">Open the evidence document</a> · machine route <span class="mono">/console/validation/api/evidence/${esc(
    experiment.id,
  )}</span></p>
${coverageSection}
<h2>Workload and corpus</h2>
${keyValueTable([
  [
    "Workload families",
    experiment.families.length === 0
      ? "app-local corpus (no golden-family linkage)"
      : experiment.families.join(", "),
  ],
  ["Corpus tasks", String(experiment.corpusTaskCount)],
  [
    "Applications",
    experiment.apps.map((app) => `benchmarks/validation/apps/${app.dir}`).join(", "),
  ],
])}
${tasksDisclosure}
${rerunnable ? validationAccessSection(experiment) : ""}
<h2>Run it (the rerun center)</h2>
${
  rerunnable
    ? `<p class="muted">Every mode creates a NEW immutable run identity; the lineage metadata links it to this definition. The pinned default task is <span class="mono">${
        defaultTask?.taskId ?? ""
      }</span>.</p>`
    : ""
}
${runSurface}
<h2>Run history (this browser)</h2>
${validationHistorySection(experiment, history)}
${sdkExample}
<h2>Reproducibility</h2>
${keyValueTable([
  [
    "Repository suites",
    experiment.apps.some((app) => app.suitePath !== null)
      ? experiment.apps
          .map((app) => app.suitePath)
          .filter((path): path is string => path !== null)
          .join(", ")
      : "recorded in the evidence document",
  ],
  ["Environment gates", experiment.apps.flatMap((app) => app.liveGateEnvVars).join(", ") || "—"],
  ["Bundle export", `/console/validation/api/${experiment.id}/bundle.json`],
])}
<p class="muted">${esc(RECENTS_NOTE)}.</p>`;
  return page(
    {
      title: `Zeck — ${experiment.id}`,
      activePath: "/console/validation",
      mainContent: content,
    },
    ctx,
    { setCookies },
  );
}

async function createValidationRunHandler(
  client: ZeckClient,
  scope: string,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const workOrderId = ctx.params.workOrder ?? "";
  const experiment = experimentOf(workOrderId);
  if (experiment === null) {
    return validationExperimentNotFoundView(workOrderId, ctx);
  }
  const wantsJson = (ctx.form.format ?? "").trim() === "json";
  const idempotencyKey = (ctx.form.idempotencyKey ?? "").trim();
  const validation = validateValidationRunForm(experiment, ctx.form);
  const defaultTask = defaultTaskOf(experiment);
  const rerunRefusedView = (
    status: number,
    statusMessage: string,
    surface: string,
  ): HandlerResult =>
    htmlStatusResult(
      status,
      appShell({
        title: `Zeck — ${experiment.id}`,
        activePath: "/console/validation",
        mainContent: `${pageHead({
          title: `${experiment.id} — ${experiment.title}`,
          path: "/console/validation",
          currentLabel: experiment.id,
        })}
<div id="form-status" role="status" aria-live="polite" class="live-region">${esc(statusMessage)}</div>
${surface}`,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  if (!experimentIsRerunnable(experiment) || defaultTask === null) {
    if (wantsJson) {
      return {
        status: 409,
        body: JSON.stringify(
          {
            error: "NOT_RUN",
            workOrder: experiment.id,
            reason:
              "this experiment's reproduction path is the repository's governed suites — the console does not re-execute them",
            bundle: `/console/validation/api/${experiment.id}/bundle.json`,
          },
          null,
          2,
        ),
        contentType: "application/json",
      };
    }
    return rerunRefusedView(
      409,
      "This experiment is not console-rerunnable — its reproduction path is the repository suite.",
      `<div class="state state-unavailable">
  <p class="state-title">Console rerun — NOT RUN for this experiment</p>
  <p class="state-body">The repository's governed suites are the reproduction path; the full battery re-run is the Lead's credentialed environment.</p>
  <p class="state-source">Export the bundle: <a href="/console/validation/api/${encodeURIComponent(
    experiment.id,
  )}/bundle.json">${esc(experiment.id)} bundle.json</a></p>
</div>`,
    );
  }
  if (validation.values === null || idempotencyKey.length === 0) {
    const errors: Record<string, string | undefined> = {
      ...(validation.errors as Record<string, string | undefined>),
    };
    if (idempotencyKey.length === 0) {
      errors.applicationId =
        (errors.applicationId ?? "") +
        (errors.applicationId === undefined ? "" : " ") +
        "The form state was lost — fill the application id again and resubmit.";
    }
    if (wantsJson) {
      return {
        status: 422,
        body: JSON.stringify(
          { error: "INVALID_FORM", workOrder: experiment.id, fields: validation.errors },
          null,
          2,
        ),
        contentType: "application/json",
      };
    }
    return rerunRefusedView(
      422,
      "The rerun could not be submitted — fix the highlighted fields.",
      validationRunForm(
        experiment,
        defaultTask.taskId,
        { ...ctx.form, applicationId: ctx.form.applicationId ?? scope },
        errors,
        idempotencyKey.length > 0 ? idempotencyKey : `dash-${crypto.randomUUID()}`,
      ),
    );
  }
  const availability = availabilityOf(experiment);
  if (availability.hardBlocked.length > 0) {
    if (wantsJson) {
      return {
        status: 409,
        body: JSON.stringify(
          {
            error: "NOT_RUN",
            workOrder: experiment.id,
            reason:
              "a required capability has no candidate provider in the authorized set — surfaced before execution, never a pass",
            hardBlocked: availability.hardBlocked,
          },
          null,
          2,
        ),
        contentType: "application/json",
      };
    }
    return rerunRefusedView(
      409,
      "The rerun was refused before any wire call — a required capability has no provider in the authorized set.",
      validationAccessSection(experiment),
    );
  }
  const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
  const recents = await readRecentExecutions(client, ids);
  const inFlight = inFlightCount(recents.executions);
  if (inFlight >= VALIDATION_MAX_CONCURRENT_RUNS) {
    if (wantsJson) {
      return {
        status: 429,
        body: JSON.stringify(
          {
            error: "CONCURRENCY_LIMIT",
            workOrder: experiment.id,
            inFlight,
            limit: VALIDATION_MAX_CONCURRENT_RUNS,
          },
          null,
          2,
        ),
        contentType: "application/json",
      };
    }
    return rerunRefusedView(
      422,
      "The sandbox concurrency limit refused this submission.",
      validationConcurrencyGate(inFlight),
    );
  }
  const values = validation.values;
  const task =
    tasksOfExperiment(experiment).find((candidate) => candidate.taskId === values.taskId) ??
    defaultTask;
  try {
    const request = buildValidationRunRequest(experiment, task, values);
    const { receipt } = await client.createExecution(request, idempotencyKey);
    if (wantsJson) {
      return {
        status: 200,
        body: JSON.stringify(
          {
            executionId: receipt.executionId,
            status: receipt.status,
            workOrder: experiment.id,
            mode: values.mode,
            corpusTask: task.taskId,
            runRecord: `/console/validation/api/runs/${encodeURIComponent(receipt.executionId)}.json`,
            run: `/runs/${encodeURIComponent(receipt.executionId)}`,
          },
          null,
          2,
        ),
        contentType: "application/json",
      };
    }
    return redirectResult(`/runs/${encodeURIComponent(receipt.executionId)}`);
  } catch (error) {
    if (error instanceof ZeckApiError && error.status < 500) {
      const policyBoundary =
        error.body.code === "POLICY_DENIED" || error.body.code === "BUDGET_EXCEEDED"
          ? `\n${createBlockedExplanation(error.body.code, error.body.message)}`
          : "";
      if (wantsJson) {
        return {
          status: error.status,
          body: JSON.stringify(
            {
              error: error.body.code,
              message: error.body.message,
              retryable: error.body.retryable,
            },
            null,
            2,
          ),
          contentType: "application/json",
        };
      }
      const request = buildValidationRunRequest(experiment, task, values);
      return rerunRefusedView(
        422,
        `The platform rejected this rerun: ${error.body.message} (${error.body.code})`,
        `${policyBoundary}
${validationEnvelope(request, task)}
${validationCommitmentCard(
  experiment,
  {
    applicationId: values.applicationId,
    environmentId: values.environmentId,
    spendLimitDollars: values.spendLimitDollars,
    mode: values.mode,
    taskId: values.taskId,
    idempotencyKey,
  },
  request,
  idempotencyKey,
  "Try again",
)}`,
      );
    }
    throw error;
  }
}

async function validationComparePage(client: ZeckClient, ctx: HttpContext): Promise<HandlerResult> {
  const runsParam = ctx.query.get("runs") ?? "";
  const requested = runsParam
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, 6);
  const workOrderParam = ctx.query.get("workOrder") ?? "";
  const experiment =
    experimentOf(workOrderParam) ?? (requested.length === 0 ? experimentOf("VAL-010") : null);
  const rows: string[] = [];
  for (const executionId of requested) {
    try {
      const execution = await client.getExecution(executionId);
      let result: ExecutionResult | null = null;
      try {
        result = await client.getResult(executionId);
      } catch (error) {
        if (!(error instanceof ZeckApiError && error.status === 404)) {
          throw error;
        }
      }
      const comparison = validationComparisonOf(execution, result);
      const verdict = (matches: boolean | null): string =>
        matches === null ? "—" : matches ? "✓ matches" : "✗ differs";
      rows.push(`<tr>
      <td><a href="/runs/${encodeURIComponent(execution.id)}" class="mono">${esc(
        execution.id,
      )}</a></td>
      <td>${esc(comparison.mode ?? "—")}</td>
      <td class="mono">${esc(comparison.corpusTask ?? "—")}</td>
      <td>${statusBadge(comparison.status)}</td>
      <td>${esc(comparison.expectedTerminalStatus ?? "—")}<br><span class="muted">${esc(
        verdict(comparison.matchesExpectedTerminal),
      )}</span></td>
      <td>${esc(comparison.expectedVerification ?? "—")}<br><span class="muted">${esc(
        verdict(comparison.matchesExpectedVerification),
      )}</span></td>
      <td>${comparison.costMicroUsd === null ? "—" : formatMicroUsd(comparison.costMicroUsd)}</td>
      <td>${comparison.durationMs === null ? "—" : formatDuration(comparison.durationMs)}</td>
    </tr>`);
    } catch (error) {
      if (!(error instanceof ZeckApiError && error.status === 404)) {
        throw error;
      }
      rows.push(`<tr>
      <td class="mono">${esc(executionId)}</td>
      <td colspan="7">${errorState(
        "Run not readable",
        `No execution "${executionId}" is readable through the governed API in this scope — the comparison states the absence honestly.`,
      )}</td>
    </tr>`);
    }
  }
  const table =
    requested.length === 0
      ? emptyState(
          "No runs to compare yet",
          "Enter two or more execution ids (or open an experiment and use its run history's compare link). Every fact below reads live through the governed API; the corpus's recorded expectation is the baseline column.",
        )
      : `<table class="data">
  <thead><tr><th scope="col">Run</th><th scope="col">Mode</th><th scope="col">Corpus task</th><th scope="col">Status</th><th scope="col">Expected terminal</th><th scope="col">Expected verification</th><th scope="col">Cost</th><th scope="col">Duration</th></tr></thead>
  <tbody>${rows.join("")}</tbody>
</table>
<p class="muted">A "✗ differs" row is an honest finding — never converted into a pass, never retried away. The recorded baseline comes from the corpus row the run's lineage names; the original evidence document stays one click away on the experiment page.</p>`;
  const contextSection =
    experiment === null
      ? ""
      : `<h2>Against ${esc(experiment.id)}</h2>
<p>${esc(experiment.objective)}</p>
<p><a href="/console/validation/${encodeURIComponent(
          experiment.id,
        )}">The experiment</a> · <a href="/console/validation/evidence/${encodeURIComponent(
          experiment.id,
        )}">The original evidence</a></p>`;
  const content = `${pageHead({
    title: "Validation Lab — compare runs",
    path: "/console/validation",
    currentLabel: "Compare",
  })}
<p>Compare reruns (and any governed execution) against each other and against the corpus's recorded expectation — the original evidence document stays immutable, and every comparison fact reads live through the governed API.</p>
${validationTabNav("all")}
<form class="flow card" method="get" action="/console/validation/compare">
  ${executionFormField(
    "vc-runs",
    "Execution ids (comma-separated, up to six)",
    `<input id="vc-runs" name="runs" value="${esc(runsParam)}" placeholder="id-one,id-two">`,
    "The runs to compare — each is read live; an unreadable id renders an honest absence row.",
  )}
  ${executionFormField(
    "vc-workorder",
    "Experiment context (optional)",
    `<input id="vc-workorder" name="workOrder" value="${esc(workOrderParam)}" placeholder="VAL-010">`,
    "Adds the definition's objective and evidence links above the comparison.",
  )}
  <div class="form-actions"><button type="submit" class="primary">Compare</button></div>
</form>
${contextSection}
${table}`;
  return page(
    {
      title: "Zeck — Validation Lab compare",
      activePath: "/console/validation",
      mainContent: content,
    },
    ctx,
  );
}

// The agent/machine routes (DEP-025 AC3 — the same projection, JSON)

function jsonResult(body: string, status = 200): HandlerResult {
  return { status, body, contentType: "application/json" };
}

function validationCatalogRoute(): HandlerResult {
  return jsonResult(validationCatalogJson());
}

function validationSchemaRoute(): HandlerResult {
  return jsonResult(agentSchemaJson());
}

function validationDefinitionRoute(ctx: HttpContext): Promise<HandlerResult> {
  const artifact = ctx.params.artifact ?? "";
  const match = /^(VAL-\d{3})\.json$/.exec(artifact);
  if (match === null) {
    return Promise.resolve(
      jsonResult(
        JSON.stringify(
          {
            error: "NOT_FOUND",
            reason: "the definition route serves /console/validation/api/VAL-NNN.json",
            catalog: "/console/validation/api/catalog.json",
          },
          null,
          2,
        ),
        404,
      ),
    );
  }
  const experiment = experimentOf(match[1] ?? "");
  if (experiment === null) {
    return Promise.resolve(
      jsonResult(
        JSON.stringify(
          {
            error: "NOT_FOUND",
            reason: `the governed program state records no experiment ${String(match[1])}`,
            unissuedIds: unissuedValidationIds(),
          },
          null,
          2,
        ),
        404,
      ),
    );
  }
  return Promise.resolve(jsonResult(experimentDefinitionJson(experiment)));
}

function validationBundleRoute(ctx: HttpContext): Promise<HandlerResult> {
  const workOrder = ctx.params.workOrder ?? "";
  const experiment = experimentOf(workOrder);
  if (experiment === null) {
    return Promise.resolve(
      jsonResult(
        JSON.stringify({ error: "NOT_FOUND", reason: `no experiment ${workOrder}` }, null, 2),
        404,
      ),
    );
  }
  const evidence = readValidationEvidence(workOrder);
  if (evidence === null) {
    return Promise.resolve(
      jsonResult(
        JSON.stringify({ error: "NOT_FOUND", reason: "evidence document unreadable" }, null, 2),
        404,
      ),
    );
  }
  return Promise.resolve(jsonResult(reproducibilityBundleJson(experiment, evidence.content)));
}

function validationEvidenceRoute(ctx: HttpContext): HandlerResult {
  const workOrder = ctx.params.workOrder ?? "";
  const evidence = readValidationEvidence(workOrder);
  if (evidence === null) {
    return jsonResult(
      JSON.stringify({ error: "NOT_FOUND", reason: `no experiment ${workOrder}` }, null, 2),
      404,
    );
  }
  return assetResult(evidence.content, "text/markdown");
}

async function validationRunRecordRoute(
  client: ZeckClient,
  ctx: HttpContext,
): Promise<HandlerResult> {
  const artifact = ctx.params.executionId ?? "";
  const match = /^(.+)\.json$/.exec(artifact);
  const executionId = match === null ? artifact : (match[1] ?? "");
  if (executionId.length === 0) {
    return jsonResult(
      JSON.stringify({ error: "NOT_FOUND", reason: "no execution id" }, null, 2),
      404,
    );
  }
  try {
    const execution = await client.getExecution(executionId);
    const [result, events, verification] = await Promise.all([
      client.getResult(executionId).catch((error: unknown) => {
        if (error instanceof ZeckApiError && error.status === 404) {
          return null;
        }
        throw error;
      }),
      client.listEvents(executionId).catch((error: unknown) => {
        if (error instanceof ZeckApiError && error.status === 404) {
          return [];
        }
        throw error;
      }),
      client.listVerification(executionId).catch((error: unknown) => {
        if (error instanceof ZeckApiError && error.status === 404) {
          return [];
        }
        throw error;
      }),
    ]);
    return jsonResult(
      runRecordJson({
        execution,
        result,
        events,
        verification,
        now: new Date().toISOString(),
      }),
    );
  } catch (error) {
    if (error instanceof ZeckApiError && error.status === 404) {
      return jsonResult(
        JSON.stringify(
          {
            error: "NOT_FOUND",
            reason: `no execution ${executionId} is readable through the governed API in this scope`,
          },
          null,
          2,
        ),
        404,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Providers & capabilities, docs, settings
// ---------------------------------------------------------------------------

async function providersPage(ctx: HttpContext): Promise<HandlerResult> {
  const split = familiesByClassification();
  const capabilityRows = `<table class="data">
  <thead><tr><th scope="col">Capability</th><th scope="col">Kind</th><th scope="col">Version</th></tr></thead>
  <tbody>${seedCapabilities()
    .map(
      (capability) => `<tr>
      <td class="mono">${esc(capability.id)}</td>
      <td>${esc(capability.kind)}</td>
      <td class="mono">${esc(capability.version)}</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;
  const content = `${pageHead({ title: "Providers & capabilities", path: "/console/providers" })}
<p>Zeck is provider-neutral: a task and its constraints cross the public API, the platform plans the route, and provider identifiers cross back only as opaque neutral strings inside run route facts. This page projects the seeded capability catalog and the recorded availability — the machine capability manifest is the single source, validated against the validation corpus.</p>
<h2>Seeded capabilities</h2>
${capabilityRows}
<h2>The vocabularies</h2>
${keyValueTable([
  ["Capability kinds", capabilityKinds().join(", ")],
  ["Evidence kinds", evidenceKinds().join(", ")],
])}
<h2>Workload family availability</h2>
${distinctionList([
  {
    label: `${split.runnable.length} runnable families`,
    fact: "The full integration path (submit → lifecycle → result/evidence/cost) runs against any deployment exposing the public API, and the family is exercised by the executed validation program.",
    backed: true,
  },
  {
    label: `${split.providerGated.length} provider-gated families`,
    fact: "The code path is identical, but completion requires provider capabilities whose access is gated (credential, region, quota) or absent from the authorized set — the recorded boundary states exactly which, and a NOT RUN boundary is never converted into a pass.",
    backed: true,
  },
])}
<p>Browse every family on the <a href="/console/playground">playground</a>; the per-family boundaries live on each family page. The provider-level table and its disclosure rules: <a href="/console/docs/AVAILABILITY.md">AVAILABILITY.md</a> and <a href="/console/docs/CONFIGURATION.md">CONFIGURATION.md</a> in the docs.</p>
${unavailableState(
  "Provider inventory",
  "There is no provider inventory route in the public API — providers cross as opaque neutral strings in run route facts, connections are BYOK and secret-mediated, and the platform's provider federation owns provider lifecycle. Routing facts from real runs: the Connections surface.",
  "the provider federation authority through the public API",
)}
<p>Routing facts from real runs (BYOK, secret-mediated): <a href="/assets/connections">Connections</a>.</p>`;
  return page(
    {
      title: "Zeck — Providers & capabilities",
      activePath: "/console/providers",
      mainContent: content,
    },
    ctx,
  );
}

async function docsPage(ctx: HttpContext): Promise<HandlerResult> {
  const entries = developerDocsIndex();
  const content = `${pageHead({ title: "Docs", path: "/console/docs" })}
<p>The developer documentation — served verbatim from the repository's public integration kit (no copied or paraphrased duplicate; the directory is the index). Readable by humans and coding agents, every claim links to the artifact that backs it.</p>
<ul class="runs-list">
  ${entries
    .map(
      (entry) => `<li>
  <div class="run-line">
    <a class="run-title" href="/console/docs/${encodeURIComponent(entry.id)}">${esc(entry.title)}</a>
  </div>
  <p class="muted mono">${esc(entry.id)}</p>
</li>`,
    )
    .join("\n  ")}
</ul>`;
  return page({ title: "Zeck — Docs", activePath: "/console/docs", mainContent: content }, ctx);
}

async function docFilePage(ctx: HttpContext): Promise<HandlerResult> {
  const docId = ctx.params.docId ?? "";
  const doc = readDeveloperDoc(docId);
  if (doc === null) {
    const content = `${pageHead({ title: "Document not found", path: "/console/docs" })}
${errorState(
  "No such developer document",
  `No document "${docId}" exists in the projected docs directory — the console serves the repository's developer docs verbatim and invents nothing.`,
  "docs/developer/ (the public integration kit)",
)}
<p><a href="/console/docs">Back to the docs index</a></p>`;
    return htmlStatusResult(
      404,
      appShell({
        title: "Zeck — Document not found",
        activePath: "/console/docs",
        mainContent: content,
        appearance: appearanceOf(ctx.cookies),
        mode: modeOf(ctx.cookies),
        returnTo: ctx.path,
      }),
    );
  }
  const content = `${pageHead({
    title: doc.entry.title,
    path: "/console/docs",
    currentLabel: doc.entry.id,
    primaryActionHtml: '<a class="button-link" href="/console/docs">All docs</a>',
  })}
<p class="muted mono">${esc(doc.entry.id)} — served verbatim from the repository.</p>
<pre class="raw">${esc(doc.content)}</pre>`;
  return page(
    {
      title: `Zeck — ${doc.entry.title}`,
      activePath: "/console/docs",
      mainContent: content,
    },
    ctx,
  );
}

async function settingsPage(ctx: HttpContext): Promise<HandlerResult> {
  const content = `${pageHead({ title: "Settings", path: "/console/settings" })}
<p>Console preferences are presentation state only — they live in disclosed cookies and never touch platform facts. Platform-level control surfaces stay under Control.</p>
<h2>Appearance</h2>
${renderAppearanceForm(appearanceOf(ctx.cookies), "/console/settings")}
<h2>Experience mode</h2>
${modeSelectionForm(modeOf(ctx.cookies), "/console/settings")}
<h2>Recent executions (this browser)</h2>
<p>The recents list is navigation-only and disclosed: it stores execution ids opened in this browser (at most 8, most recent first) so Active/History/Usage can re-read them live. Every view still reads through the governed API — the list holds no facts.</p>
<p><a class="button-link danger" href="/console/settings/reset-recents">Clear the recents list</a></p>
<h2>Team and governance</h2>
<p>Who decides what, roles and the live approval queue live in the Control area: <a href="/admin/team">Team</a> and <a href="/admin/policies">Policies</a>.</p>
${unavailableState(
  "Account-level console settings",
  "There is no account settings route in the public API — the console holds only the presentation preferences above. When an account surface ships, its facts will come from the identity authority through the public API.",
  "the identity authority through the public API",
)}`;
  return page(
    { title: "Zeck — Settings", activePath: "/console/settings", mainContent: content },
    ctx,
  );
}

async function resetRecentsPage(ctx: HttpContext): Promise<HandlerResult> {
  void ctx;
  return redirectResult("/console/settings", {
    setCookies: [
      serializeCookie(RECENTS_COOKIE, "", {
        path: "/",
        maxAge: 0,
        httpOnly: true,
        sameSite: "Lax",
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

/** Options for the dashboard route table (DEP-010 console surfaces). */
export interface DashboardRoutesOptions {
  /**
   * The deployment's application scope — pre-fills the console's
   * application-sensitive surfaces. The SDK client carries the
   * authoritative binding (X-Zeck-Application on every scoped call);
   * this value is presentation prefill only.
   */
  readonly applicationId?: string;
  /**
   * The credential-console transport (DEP-011): the projection seam over
   * the public credential routes. OPTIONAL — when absent, the console
   * derives it from the deployment's environment contract
   * (ZECK_API_URL / ZECK_TOKEN / ZECK_APPLICATION_ID, the same variables
   * the dashboard entry point requires) and renders the honest unavailable
   * state when those are not bound. The console holds zero credential
   * state of its own either way.
   */
  readonly credentials?: CredentialConsoleTransport;
  /**
   * The sandbox-governance transport (DEP-014): the projection seam over
   * the public sandbox governance routes. OPTIONAL — the same
   * environment-derivation discipline as the credentials seam.
   */
  readonly sandboxGovernance?: SandboxGovernanceTransport;
}

/** Create the dashboard route table bound to one SDK client. */
export function createDashboardRoutes(
  client: ZeckClient,
  options: DashboardRoutesOptions = {},
): readonly RouteDefinition[] {
  const scope = options.applicationId ?? "";
  // DEP-011: the credential transport — injectable through the options
  // seam; otherwise derived from the deployment's environment contract
  // (null ⇒ the honest unavailable states, never a fabricated transport).
  const credentials =
    options.credentials !== undefined ? options.credentials : credentialTransportFromEnvironment();
  // DEP-014: the sandbox governance transport — the same injectable/
  // env-derived discipline (null ⇒ the honest unavailable states).
  const sandboxGovernance =
    options.sandboxGovernance !== undefined
      ? options.sandboxGovernance
      : sandboxGovernanceTransportFromEnvironment();
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
    // Developer console (DEP-010). Static routes precede parameterized
    // ones: keys/environments/usage must win over :applicationId.
    wrap("GET", "/console", (ctx) => consoleHomePage(scope, ctx)),
    wrap("GET", "/console/quickstart", (ctx) => quickstartPage(scope, ctx)),
    wrap("GET", "/console/applications", (ctx) => applicationsPage(client, scope, ctx)),
    wrap("GET", "/console/applications/keys", (ctx) => credentialsPage(credentials, scope, ctx)),
    // DEP-011: the credential lifecycle's governed POSTs (issue → show-once
    // reveal; rotate → successor reveal; revoke → PRG back to the list).
    wrap("POST", "/console/applications/keys/issue", (ctx) =>
      credentialIssueHandler(credentials, scope, ctx),
    ),
    wrap("POST", "/console/applications/keys/:credentialId/rotate", (ctx) =>
      credentialRotateHandler(credentials, scope, ctx),
    ),
    wrap("POST", "/console/applications/keys/:credentialId/revoke", (ctx) =>
      credentialRevokeHandler(credentials, scope, ctx),
    ),
    wrap("GET", "/console/applications/environments", (ctx) =>
      environmentsConsolePage(client, ctx, sandboxGovernance),
    ),
    wrap("GET", "/console/applications/usage", (ctx) => usagePage(client, ctx)),
    wrap("GET", "/console/applications/:applicationId", (ctx) =>
      applicationDetailPage(client, ctx),
    ),
    wrap("GET", "/console/playground", (ctx) => playgroundPage(ctx)),
    wrap("GET", "/console/playground/:family", (ctx) => playgroundFamilyPage(client, scope, ctx)),
    wrap("POST", "/console/playground/:family", (ctx) =>
      createPlaygroundRunHandler(client, scope, ctx),
    ),
    // DEP-013: the copyable integration-kit example behind each family
    // (machine parity — served read-only from the repository).
    wrap("GET", "/console/playground/:family/example", (ctx) => playgroundExamplePage(ctx)),
    // Executions explorer (DEP-012): the list → six-view detail → machine
    // facts chain. Static list route first, then the parameterized detail
    // and its verbatim-JSON machine twin.
    wrap("GET", "/console/executions", (ctx) => executionsConsolePage(client, ctx)),
    wrap("GET", "/console/executions/facts.json", async (ctx) => {
      const ids = parseRecents(ctx.cookies[RECENTS_COOKIE]);
      const { executions, survivingIds } = await readRecentExecutions(client, ids);
      const results = await readResults(client, survivingIds);
      return jsonResult(
        JSON.stringify(explorerListFactsJson(explorerRunsOf(executions, results)), null, 2),
      );
    }),
    wrap("GET", "/console/executions/:executionId/facts.json", (ctx) =>
      executionFactsRoute(client, ctx),
    ),
    // Reproducibility-bundle export (DEP-032): the bundle view + the
    // verbatim-JSON machine twin (the machine view plus recipe).
    wrap("GET", "/console/executions/:executionId/export/bundle.json", (ctx) =>
      executionExportBundleRoute(client, ctx),
    ),
    wrap("GET", "/console/executions/:executionId/export", (ctx) =>
      executionExportPage(client, ctx),
    ),
    wrap("GET", "/console/executions/:executionId", (ctx) => executionExplorerPage(client, ctx)),
    // Playground compare (DEP-031): baseline-vs-strategy comparison over
    // the SAME public records — the selection picker + the side-by-side
    // view + the verbatim-JSON machine twin (the SAME composition — no
    // UI-only state), and the baseline launcher's governed POST (the
    // frozen create contract carrying the recorded baseline lineage
    // metadata — never a provider/model selection).
    wrap("GET", "/console/compare", (ctx) => compareConsolePage(client, ctx)),
    wrap("GET", "/console/compare/facts.json", (ctx) => compareFactsRoute(client, ctx)),
    wrap("POST", "/console/compare/baseline", (ctx) => compareBaselineLaunchHandler(client, ctx)),
    // Usage, economics and optimization (DEP-030): the first-class
    // application-scoped usage projection + its machine twin (the SAME
    // composition — no UI-only state). The budgets transport derives
    // per-request from the deployment's environment contract (null ⇒ the
    // honest unavailable states, never a fabricated transport).
    wrap("GET", "/console/usage", (ctx) =>
      usageConsolePage(client, usageBudgetsTransportFromEnvironment(), ctx),
    ),
    wrap("GET", "/console/usage/facts.json", (ctx) =>
      usageFactsRoute(client, usageBudgetsTransportFromEnvironment(), ctx),
    ),
    // Validation Lab (DEP-025). Static routes precede parameterized ones:
    // capability/workload/stage/start/agent/compare must win over
    // :workOrder, and the machine routes sit under the api/ prefix.
    wrap("GET", "/console/validation", (ctx) => validationLabPage(ctx)),
    wrap("GET", "/console/validation/capability", (ctx) => validationCapabilityPage(ctx)),
    wrap("GET", "/console/validation/workload", (ctx) => validationWorkloadPage(ctx)),
    wrap("GET", "/console/validation/stage", (ctx) => validationStagePage(ctx)),
    wrap("GET", "/console/validation/start", (ctx) => validationStartPage(ctx)),
    wrap("GET", "/console/validation/agent", (ctx) => validationAgentPage(ctx)),
    wrap("GET", "/console/validation/compare", (ctx) => validationComparePage(client, ctx)),
    wrap("GET", "/console/validation/api/catalog.json", () => validationCatalogRoute()),
    wrap("GET", "/console/validation/api/schema.json", () => validationSchemaRoute()),
    wrap("GET", "/console/validation/api/evidence/:workOrder", (ctx) =>
      validationEvidenceRoute(ctx),
    ),
    wrap("GET", "/console/validation/api/runs/:executionId", (ctx) =>
      validationRunRecordRoute(client, ctx),
    ),
    wrap("GET", "/console/validation/api/:workOrder/bundle.json", (ctx) =>
      validationBundleRoute(ctx),
    ),
    wrap("GET", "/console/validation/api/:artifact", (ctx) => validationDefinitionRoute(ctx)),
    wrap("GET", "/console/validation/evidence/:workOrder", (ctx) => validationEvidencePage(ctx)),
    wrap("GET", "/console/validation/:workOrder", (ctx) =>
      validationExperimentPage(client, scope, ctx),
    ),
    wrap("POST", "/console/validation/:workOrder/run", (ctx) =>
      createValidationRunHandler(client, scope, ctx),
    ),
    wrap("GET", "/console/providers", (ctx) => providersPage(ctx)),
    wrap("GET", "/console/docs", (ctx) => docsPage(ctx)),
    wrap("GET", "/console/docs/:docId", (ctx) => docFilePage(ctx)),
    wrap("GET", "/console/settings", (ctx) => settingsPage(ctx)),
    wrap("GET", "/console/settings/reset-recents", (ctx) => resetRecentsPage(ctx)),
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
